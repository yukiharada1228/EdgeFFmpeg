import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
// amount strictly between 0 and 1 leaves two inexact products in `procL + inL*(1-amount)`, which macOS clang contracts into fma: those cases run on Linux x86-64 only.
const linux=process.platform==='linux'&&process.arch==='x64';
const sources=[['u8',1,8000],['s16le',2,44100],['s32le',4,48000],['f32le',4,8000],['f64le',8,44100]] as const;
/** Deterministic stereo PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=1<<20){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  for(const [raw,width]of sources)writeFileSync(join(root,`${raw}.raw`),pcm(width,raw.startsWith('f'),6000*2));
  execFileSync(native,['-v','error','-f','s16le','-ar','48000','-ac','2','-i',join(root,'s16le.raw'),'-bitexact',join(root,'input.wav')]);
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<23,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:20000}})};
}
type Harness = Awaited<ReturnType<typeof harness>>;
const declared=(source:string)=>{const entry=sources.find(([raw])=>`${raw}.raw`===source);return entry?['-f',entry[0],'-ar',String(entry[2]),'-ac','2']:[];};
const outputs:readonly (readonly string[])[]=[['-c:a','pcm_f64le','-f','f64le'],['-c:a','pcm_s16le','-f','s16le'],['-c:a','pcm_s16le','-bitexact','-f','framecrc'],['-c:a','pcm_f64le','-bitexact','-f','framecrc']];
let counter=0;
/** One byte comparison: native writes to stdout, EdgeFFmpeg to a file in the per-test root. */
async function compare({root,frontend}:Harness,source:string,chain:string,output:readonly string[]):Promise<void> {
  const before=['-cpuflags','0',...declared(source)],after=['-af',chain,...output],expected=execFileSync(native,['-v','error',...before,'-i',join(root,source),...after,'-'],{maxBuffer:1<<26}),out=`/${counter++}.out`,result=await frontend.exec([...before,'-i',`/${source}`,...after,out]);
  const label=`${source} ${chain} ${output.join(' ')}`;
  expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);
  expect(readFileSync(join(root,out.slice(1))).equals(expected),label).toBe(true);
  rmSync(join(root,out.slice(1)));
}
const modes=['triangle','square','sawup','sawdown'] as const,timings=['timing=bpm:bpm=30','timing=bpm:bpm=137.5','timing=ms:ms=10','timing=ms:ms=777','timing=hz:hz=0.01','timing=hz:hz=100'] as const;
const offsets=['offset_l=0:offset_r=0.5','offset_l=0.5:offset_r=1','offset_l=1:offset_r=0'] as const,widths=['width=0','width=1','width=2'] as const;
/** Every mode x timing x offsets x width x source for one amount, rotating outputs so every source meets every output. */
function sweep(amount:string):[string,string,readonly string[]][] {
  const cases:[string,string,readonly string[]][]=[];let index=0;
  for(const mode of modes)for(const timing of timings)for(const offset of offsets)for(const width of widths){
    for(const [raw]of sources)cases.push([`${raw}.raw`,`apulsator=mode=${mode}:amount=${amount}:${timing}:${offset}:${width}`,outputs[index%outputs.length]!]);index++;
  }
  return cases;
}
it('runs against the 946fcce0 reference built with --disable-x86asm',()=>{
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
});
it('matches native bytes for every non-sine mode, bpm/ms/hz timing, offsets and widths with amount 0 and 1 and level edges',async()=>{
  const context=await harness('edgeffmpeg-apulsator-exact-');
  try{
    let compared=0;
    for(const amount of ['0','1'])for(const [source,chain,output]of sweep(amount)){await compare(context,source,chain,output);compared++;}
    // Power-of-two level_in/level_out edges keep every product exact.
    for(const levels of ['level_in=0.015625:level_out=64','level_in=64:level_out=0.015625','level_in=1:level_out=64'])for(const mode of modes)for(const [raw]of sources){await compare(context,`${raw}.raw`,`apulsator=${levels}:mode=${mode}`,outputs[compared%outputs.length]!);compared++;}
    expect(compared).toBe(2*4*6*3*3*5+3*4*5);
  }finally{rmSync(context.root,{recursive:true,force:true});}
},600000);
it.skipIf(!linux)('matches native bytes for every non-sine mode and timing with amount 0.6 on linux-x64',async()=>{
  const context=await harness('edgeffmpeg-apulsator-float-');
  try{
    let compared=0;
    for(const [source,chain,output]of sweep('0.6')){await compare(context,source,chain,output);compared++;}
    for(const chain of ['apulsator=mode=triangle:amount=0.6:level_in=0.7:level_out=1.3','apulsator=0.5:2:sawdown:0.25:0.1:0.9:1.5:ms:120:33:3','asetnsamples=n=7:p=0,apulsator=mode=sawup:amount=0.6,asetnsamples=n=7:p=0','volume=0.5,apulsator=mode=square:amount=0.6,apad=pad_len=9'])for(const source of ['s16le.raw','f64le.raw','input.wav'])for(const output of outputs){await compare(context,source,chain,output);compared++;}
    expect(compared).toBe(4*6*3*3*5+4*3*4);
  }finally{rmSync(context.root,{recursive:true,force:true});}
},600000);
it('matches native bytes in composed chains, WAV output and output time selection, independent of asetnsamples grouping',async()=>{
  const context=await harness('edgeffmpeg-apulsator-chains-'),{root,frontend}=context;
  try{
    const chains=['apulsator=mode=triangle','apulsator=1:1:square:1:0.25:0.75:0.5:hz:30:10:7','asetnsamples=n=7:p=0,apulsator=mode=sawup:timing=hz:hz=97','apulsator=mode=sawdown:width=0.3,asetnsamples=n=7:p=0','asetnsamples=n=7:p=0,apulsator=mode=triangle:timing=ms:ms=13,asetnsamples=n=29:p=0','volume=0.5,apulsator=mode=square,apad=pad_len=9','apad=pad_len=9,apulsator=mode=triangle:amount=0,volume=0.5','apulsator=mode=sawup,apulsator=mode=sawdown:offset_l=0.3'];
    const selected:readonly (readonly string[])[]=[...outputs,['-ss','0.01','-t','0.04','-c:a','pcm_f64le','-f','f64le'],['-ss','0.05','-c:a','pcm_s16le','-f','s16le'],['-frames:a','2','-c:a','pcm_f64le','-bitexact','-f','framecrc']];
    let compared=0;
    for(const source of ['s16le.raw','f32le.raw','u8.raw','input.wav'])for(const chain of chains)for(const output of selected){await compare(context,source,chain,output);compared++;}
    // WAV output: header and samples.
    for(const chain of ['apulsator=mode=triangle','asetnsamples=n=7:p=0,apulsator=mode=square:timing=bpm:bpm=300'])for(const codec of ['pcm_s16le','pcm_f64le']){
      const reference=join(root,`native-${counter}.wav`),out=`/${counter++}.wav`;
      execFileSync(native,['-v','error','-y','-cpuflags','0','-i',join(root,'input.wav'),'-af',chain,'-c:a',codec,'-bitexact',reference]);
      const result=await frontend.exec(['-cpuflags','0','-i','/input.wav','-af',chain,'-c:a',codec,'-bitexact',out]);
      expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(readFileSync(reference)),chain).toBe(true);compared++;
    }
    // The LFO phases persist across frames: 7- and 8-sample groupings give native's identical bytes.
    const group=(n:number)=>execFileSync(native,['-v','error','-f','s32le','-ar','48000','-ac','2','-i',join(root,'s32le.raw'),'-af',`asetnsamples=n=${n}:p=0,apulsator=mode=triangle:timing=hz:hz=61`,'-c:a','pcm_f64le','-f','f64le','-']);
    expect(group(7).equals(group(8))).toBe(true);
    for(const n of [7,8]){await compare(context,'s32le.raw',`asetnsamples=n=${n}:p=0,apulsator=mode=triangle:timing=hz:hz=61`,outputs[0]!);compared++;}
    expect(compared).toBe(4*8*7+4+2);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('fails explicitly before output for sine, non-stereo input, native option errors and unimplemented forms',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-apulsator-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*6));
    const refuse=async(label:string,nativeStatus:number,filter:string,channels=2,message:RegExp=/apulsator/)=>{
      const before=['-cpuflags','0','-f','s16le','-ar','8000','-ac',String(channels)],args=['-af',filter,'-f','framecrc'],out=`/${counter++}.crc`;
      const status=spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...args,'-']).status,result=await frontend.exec([...before,'-i','/input.raw',...args,out]);
      expect(status,label).toBe(nativeStatus);expect(result.exitCode,label).not.toBe(0);expect(result.diagnostics.at(-1)?.message,label).toMatch(message);expect(existsSync(join(root,out.slice(1))),label).toBe(false);
    };
    const erange=256-constants.errno.ERANGE,einval=256-constants.errno.EINVAL;
    // Native runs sine with libm sin(); EdgeFFmpeg refuses it, including the bare default.
    for(const filter of ['apulsator','apulsator=mode=sine','apulsator=mode=0:amount=1','apulsator=timing=hz'])await refuse(filter,0,filter,2,/apulsator mode sine requires unimplemented libm arithmetic/);
    // Native remixes mono and three-channel input implicitly.
    await refuse('mono',0,'apulsator=mode=square',1,/apulsator requires stereo input/);
    await refuse('three channels',0,'apulsator=mode=square',3,/apulsator requires stereo input/);
    // Out-of-range values fail in write_number with ERANGE.
    for(const option of ['bpm=29.9','bpm=300.5','ms=9','ms=2001','hz=0.009','hz=100.01','width=2.01','width=-0.1','amount=1.1','offset_l=-1','offset_r=1.5','level_in=0.015','level_out=65','mode=5','timing=3'])await refuse(option,erange,`apulsator=mode=square:${option}`);
    // Timeline enable fails with AVERROR_PATCHWELCOME, an unknown option with AVERROR_OPTION_NOT_FOUND, syntax with EINVAL.
    await refuse('enable',176,'apulsator=mode=square:enable=1');
    await refuse('unknown option',8,'apulsator=mode=square:foo=1');
    await refuse('positional after named',einval,'apulsator=mode=square:1');
    await refuse('unknown mode',einval,'apulsator=mode=foo');
    await refuse('too many positional values',einval,'apulsator=1:1:square:1:0:0.5:1:hz:120:500:2:1');
    // Native accepts these forms (llrint for integer options, expressions); they stay unimplemented.
    await refuse('fractional ms',0,'apulsator=mode=square:ms=10.5');
    await refuse('expression',0,'apulsator=mode=square:amount=1/2');
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
