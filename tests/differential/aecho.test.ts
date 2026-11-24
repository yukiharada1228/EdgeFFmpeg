import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
/** aecho's double/float arithmetic was verified on the pinned linux/x64 build; other hosts may contract it into FMA. */
const linux=process.platform==='linux'&&process.arch==='x64';
/** Deterministic PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=1<<22,resident=1<<25){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:resident,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:60000}})};
}
type Frontend=Awaited<ReturnType<typeof harness>>['frontend'];
let counter=0;
async function compare(root:string,frontend:Frontend,input:string,before:readonly string[],after:readonly string[],label:string){
  const expected=execFileSync(native,['-v','error',...before,'-i',join(root,input),...after,'-'],{maxBuffer:1<<26}),out=`/${counter++}.out`,result=await frontend.exec([...before,'-i',`/${input}`,...after,out]);
  expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);
  expect(readFileSync(join(root,out.slice(1))).equals(expected),label).toBe(true);
}
it.runIf(linux)('matches native framecrc across sources, channel counts, rates, tap lists and s16/f32/f64 outputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aecho-');
  // 1-3 taps; delays shorter and longer than one frame and than 2048 samples; a zero-sample tap (0.1 ms at 8000 Hz); saturation clipping.
  const chains=['aecho','aecho=0.8:0.9:20|7.3:0.5|0.3','aecho=0.8:0.88:60:0.4','aecho=0.8:0.9:1000|1800:0.3|0.25','aecho=0.6:0.3:300|0.1:0.5|0.5','aecho=1:1:1|2|3:1|1|1','aecho=0.5:1:260|30:1|0.5','aecho=in_gain=0.9:delays=11.5|47:decays=0.7|0.2:out_gain=0.75','aecho=0.5:decays=||0.25|:delays=|3|:in_gain=1:in_gain=.25'];
  try{
    for(const [raw,codec,width]of formats)for(const channels of [1,2])for(const rate of [8000,44100]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*channels));
      for(const target of [...new Set([codec,'pcm_s16le','pcm_f32le','pcm_f64le'])])for(const chain of chains)
        await compare(root,frontend,'input.raw',['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac',String(channels)],['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],`${raw}/${channels}/${rate}/${target}/${chain}`);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.runIf(linux)('matches native on long multi-frame inputs, where the tail only follows the last input frame',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aecho-long-');
  try{
    for(const [raw,codec,width]of [formats[1],formats[3],formats[4]])for(const rate of [8000,44100]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),24000*2));
      for(const chain of ['aecho=0.8:0.9:20|7.3:0.5|0.3','aecho=0.8:0.9:1000|1800:0.3|0.25','aecho=0.6:0.6:400:0.9'])for(const target of [codec,'pcm_s16le']){
        const before=['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac','2'],after=['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'];
        await compare(root,frontend,'input.raw',before,after,`${raw}/${rate}/${chain}/${target}`);
        // Every frame before the tail is an input-sized frame: no tail frame comes early.
        const crc=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']).toString().split('\n').filter(line=>/^0,/.test(line)).map(line=>Number(line.split(',')[3]));
        expect(crc.reduce((a,b)=>a+b,0)).toBe(24000+Math.max(...chain.split(':')[2]!.split('|').map(delay=>Math.trunc(Math.fround(Number(delay)*rate)/1000))));
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.runIf(linux)('matches native composed chains, output -t/-ss/-to/-frames:a and input time selection over the tail',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aecho-time-');
  const profiles:[string[],string[]][]=[[[],[]],[['-ss','0.02'],[]],[['-t','0.05'],[]],[['-ss','0.1','-t','0.02'],['-t','0.3']],[[],['-ss','0.05']],[[],['-ss','0.3']],[[],['-t','0.1']],[[],['-ss','0.03','-to','0.2']],[[],['-frames:a','3']],[[],['-frames:a','1']],[[],['-t','0.00001']],[[],['-ss','0.2','-frames:a','2']]];
  const chains=['aecho=0.8:0.9:20|300:0.5|0.3','aecho=0.8:0.9:20:0.5,asetnsamples=500','asetnsamples=300,aecho=0.8:0.9:7|260:0.5|0.5','apad=pad_len=100:packet_size=70,aecho=0.8:0.9:30:0.5','aecho=0.8:0.9:30:0.5,apad=pad_len=10','aecho=0.6:0.5:30:0.5,volume=0.5','anull,aecho=0.6:0.5:3|30:0.5|0.6,anull'];
  try{
    for(const [raw,codec,width]of [formats[1],formats[4]])for(const channels of [1,2])for(const chain of chains)for(const [input,output]of profiles){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*channels));
      await compare(root,frontend,'input.raw',['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels),...input],['-af',chain,...output,'-c:a',codec,'-bitexact','-f','framecrc'],`${raw}/${channels}/${chain}/${input.join(' ')}/${output.join(' ')}`);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.runIf(linux)('matches native output for configured empty input, where only the silent tail remains',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aecho-empty-');
  try{
    writeFileSync(join(root,'empty.raw'),new Uint8Array(0));
    for(const [raw,codec]of [formats[0],formats[1],formats[3]])for(const chain of ['aecho','aecho=0.8:0.9:20|300:0.5|0.3','aecho=0.8:0.9:20:0.5,asetnsamples=100'])for(const output of [[],['-t','0.01'],['-ss','0.01'],['-frames:a','1']])
      await compare(root,frontend,'empty.raw',['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],['-af',chain,...output,'-c:a',codec,'-bitexact','-f','framecrc'],`${raw}/${chain}/${output.join(' ')}`);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it.runIf(linux)('writes native-identical WAV and raw PCM files from WAV and raw inputs',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aecho-files-');
  try{
    let index=0;
    for(const [raw,codec,width]of formats)for(const source of ['raw','wav'])for(const container of ['wav','raw'] as const){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),1300*2));
      const input=source==='raw'?['-f',raw,'-ar','8000','-ac','2','-i']:['-i'];
      if(source==='wav')execFileSync(native,['-v','error','-y','-f',raw,'-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a','copy',join(root,'input.wav')]);
      const name=`/${index++}.${container==='raw'?'pcm':container}`,reference=join(root,`reference${name.slice(1)}`),after=['-af','aecho=0.8:0.9:20|7.3:0.5|0.3','-c:a',codec,'-bitexact','-f',container==='raw'?raw:container];
      execFileSync(native,['-v','error','-y','-cpuflags','0',...input,join(root,`input.${source}`),...after,reference]);
      const result=await frontend.exec(['-cpuflags','0',...input,`/input.${source}`,...after,name]);
      expect(result.exitCode,JSON.stringify({raw,source,container,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,name.slice(1))).equals(readFileSync(reference)),`${raw}/${source}/${container}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails explicitly before output where native fails, and for accepted forms that remain unimplemented',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aecho-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));let index=0;
    const run=async(args:readonly string[],rate=8000)=>{const before=['-cpuflags','0','-f','s16le','-ar',String(rate),'-ac','2'],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...args,'-f','framecrc',out]);return {result,out,nativeStatus:spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...args,'-f','framecrc','-']).status};};
    // [options, native accepts]: mismatched list lengths, empty lists, zero and out-of-range values, unknown or extra options fail natively;
    // expressions, exponents, signs, hexadecimal, trailing text and escaping are accepted natively but unimplemented here.
    const cases:readonly (readonly [string,boolean])[]=[['delays=1|2:decays=0.5',false],['delays=|:decays=|',false],['delays=0:decays=0.5',false],['delays=90001:decays=0.5',false],['delays=10:decays=0',false],['delays=10:decays=1.5',false],
      ['in_gain=2',false],['out_gain=1.01',false],['0.5:0.5:10:0.5:3',false],['foo=1',false],['in_gain=0.5:0.5',false],['delays=inf:decays=0.5',false],['delays=-1:decays=0.5',false],['delays=:decays=0.5',false],
      ['in_gain=1/2',true],['delays=1e1:decays=0.5',true],['delays=+10:decays=0.5',true],['delays=0x10:decays=0.5',true],['delays=10ms:decays=0.5',true],['delays=abc|5:decays=0.5',true],['in_gain=.5e0',true],['delays=10\\|20:decays=0.5|0.5',true],['delays=10:decays=0.50000002980232238769531250',true]];
    for(const [options,nativeAccepts]of cases){
      const {result,out,nativeStatus}=await run(['-af',`aecho=${options}`]);
      expect(nativeStatus===0,options).toBe(nativeAccepts);expect(result.exitCode,options).not.toBe(0);expect(result.diagnostics.at(-1)?.message,options).toMatch(/aecho/);expect(existsSync(join(root,out.slice(1))),options).toBe(false);
    }
    // Every delay truncates to zero samples at this rate: native fails configuring the output pad.
    const nothing=await run(['-af','aecho=delays=0.05:decays=0.5']);expect(nothing.nativeStatus).not.toBe(0);expect(nothing.result.exitCode).not.toBe(0);expect(nothing.result.diagnostics.at(-1)?.message).toBe('aecho has nothing to echo: missing delay samples');expect(existsSync(join(root,nothing.out.slice(1)))).toBe(false);
    // Native resamples around aecho; automatic rate conversion with a native format list is not implemented.
    const resampled=await run(['-af','aecho=0.8:0.9:20:0.5','-ar','16000']);expect(resampled.nativeStatus).toBe(0);expect(resampled.result.exitCode).not.toBe(0);expect(resampled.result.diagnostics.at(-1)?.message).toMatch(/aecho/);expect(existsSync(join(root,resampled.out.slice(1)))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses a delay ring above the buffer budget before opening output',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aecho-budget-',65536,1<<22);
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));
    // 1000 ms at 44100 Hz is 44100 samples per channel: an 88200-byte s16p ring per channel pair beyond 65536 buffer bytes.
    const result=await frontend.exec(['-f','s16le','-ar','44100','-ac','2','-i','/input.raw','-af','aecho','-f','framecrc','/too-large.crc']);
    expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.code).toBe('resource-budget');expect(existsSync(join(root,'too-large.crc'))).toBe(false);
    const fits=await frontend.exec(['-f','s16le','-ar','8000','-ac','1','-i','/input.raw','-af','aecho=0.8:0.9:20:0.5','-f','framecrc','/fits.crc']);expect(fits.exitCode,JSON.stringify(fits.diagnostics)).toBe(0);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
