import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),metadata=resolve('.build/reference/build-metadata.json');
/** Every biquad kernel is float/double multiply-add arithmetic: macOS contracts it into FMA, so byte comparisons run on linux/x64 only. */
const linux=process.platform==='linux'&&process.arch==='x64';
const formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
type Format=typeof formats[number];
const transforms=['dii','tdi','tdii','latt','svf','zdf'] as const,precisions=['auto','s16','s32','f32','f64'] as const;
/** Stable direct-form sets (normalised |a2| < 1, |a1| < 1 + a2): low-pass, high-pass, band-pass, near-unity poles, a0 != 1 with normalize, s16/s32-clipping gain, partial mixes. */
const direct=['a0=1:a1=-1.143:a2=0.4128:b0=0.0675:b1=0.135:b2=0.0675','a1=-1.143:a2=0.4128:b0=0.638:b1=-1.276:b2=0.638','a1=-1.2:a2=0.6:b0=0.2:b1=0:b2=-0.2','a1=-1.99:a2=0.995:b0=0.001:b1=0.002:b2=0.001',
  'a0=2:a1=-1.5:a2=0.5:b0=1:b1=0.5:b2=0.25:n=1','a1=-0.3:a2=0.1:b0=3:b1=-2:b2=1.5','a1=-0.9:a2=0.2:b0=0.5:b1=0.4:b2=0.3:m=0.5','a1=0.5:a2=0.3:b0=1.5:b1=1:b2=0.5:mix=0:normalize=1','a1=-1.143:a2=0.4128:b0=0.0675:b1=0.135:b2=0.0675:n=1:m=0.25'] as const;
/** zdf reads raw a0/a1/a2: these also keep its state matrix [[2a0-1,-2a1],[2a1,1-2a2]] stable. */
const zdf=['a0=0.5:a1=0.1:a2=0.2:b0=0.3:b1=0.2:b2=0.1','a0=0.6:a1=0.3:a2=0.15:b0=1:b1=-0.5:b2=0.8','a0=0.5:a1=0.49:a2=0.45:b0=0.1:b1=0.2:b2=0.1','a0=0.6:a1=0.3:a2=0.15:b0=4:b1=3:b2=-2:n=1','a0=0.5:a1=0.1:a2=0.2:b0=2:b1=1:b2=0.5:m=0.5'] as const;
const sets=(transform:string):readonly string[]=>transform==='zdf'?zdf:direct;
/** Deterministic PCM: integer formats use every byte pattern (full-scale noise), floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number,seed=0):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37+seed)&255);else{const value=i===0?-0:Math.sin(i*0.731+seed)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=1<<22,resident=1<<25){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:resident,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:60000}})};
}
type Frontend=Awaited<ReturnType<typeof harness>>['frontend'];
interface Output {readonly after:readonly string[];readonly label:string}
let counter=0;
/** One native process per input writes every output; EdgeFFmpeg then runs each output separately and must produce the same bytes. */
async function batch(root:string,frontend:Frontend,input:string,before:readonly string[],outputs:readonly Output[],extension='crc'):Promise<number>{
  const first=counter;counter+=outputs.length;const names=outputs.map((_,index)=>`native-${first+index}.${extension}`),args=['-v','error','-y',...before,'-i',join(root,input)];
  outputs.forEach((output,index)=>args.push(...output.after,join(root,names[index]!)));
  const status=spawnSync(native,args,{maxBuffer:1<<26});expect(status.status,String(status.stderr)).toBe(0);
  for(const [index,output]of outputs.entries()){
    const ours=`/ours-${first+index}.${extension}`,result=await frontend.exec([...before,'-i',`/${input}`,...output.after,ours]);
    expect(result.exitCode,JSON.stringify({label:output.label,diagnostics:result.diagnostics})).toBe(0);
    expect(readFileSync(join(root,ours.slice(1))).equals(readFileSync(join(root,names[index]!))),output.label).toBe(true);
  }
  return outputs.length;
}
const raw=([format]:Format,rate:number,channels:number)=>['-cpuflags','0','-f',format,'-ar',String(rate),'-ac',String(channels)];
const crc=(filter:string,codec:string,...extra:string[])=>['-af',filter,...extra,'-c:a',codec,'-bitexact','-f','framecrc'];
const md5=(root:string,before:readonly string[],input:string,filter:string)=>{const result=spawnSync(native,['-v','error',...before,'-i',join(root,input),'-af',filter,'-f','md5','-'],{maxBuffer:1<<20});expect(result.status,String(result.stderr)).toBe(0);return String(result.stdout).trim();};
it('runs against the pinned native commit built without x86 assembly',()=>{
  const build=JSON.parse(readFileSync(metadata,'utf8')) as {commit:string;flags:readonly string[]};
  expect(build.commit.startsWith('946fcce0')).toBe(true);expect(build.flags).toContain('--disable-x86asm');expect(existsSync(native)).toBe(true);
});
it.skipIf(!linux)('matches native framecrc for every transform and precision across raw sources, channel counts and rates',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-biquad-matrix-');let count=0;
  try{
    for(const format of formats)for(const channels of [1,2,3])for(const rate of [8000,44100]){
      const input=`input-${format[0]}-${channels}-${rate}.raw`;writeFileSync(join(root,input),pcm(format[2],format[0].startsWith('f'),900*channels,channels+rate));
      const outputs:Output[]=[];
      for(const transform of transforms)for(const precision of precisions)for(const set of sets(transform))outputs.push({after:crc(`biquad=${set}:a=${transform}:r=${precision}`,format[1]),label:`${format[0]}/${channels}/${rate}/${transform}/${precision}/${set}`});
      // Integer and floating outputs from the automatic precision: float-to-integer conversion after the filter runs with -cpuflags 0.
      for(const transform of transforms)for(const codec of ['pcm_s16le','pcm_s32le','pcm_f64le'])if(codec!==format[1])outputs.push({after:crc(`biquad=${sets(transform)[1]}:a=${transform}`,codec),label:`${format[0]}/${channels}/${rate}/${transform}/${codec}`});
      count+=await batch(root,frontend,input,raw(format,rate,channels),outputs);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(count).toBe(7932);
},600000);
it.skipIf(!linux)('writes native-identical WAV, raw and framecrc outputs from WAV inputs under output -ss, -t and -frames:a',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-biquad-files-');let count=0;
  const selections:readonly (readonly string[])[]=[[],['-ss','0.05'],['-t','0.1'],['-ss','0.02','-t','0.07'],['-frames:a','2'],['-frames:a','1']];
  try{
    for(const format of formats)for(const channels of [1,2]){
      const source=`source-${format[0]}-${channels}.raw`,input=`input-${format[0]}-${channels}.wav`;writeFileSync(join(root,source),pcm(format[2],format[0].startsWith('f'),3000*channels,7));
      expect(spawnSync(native,['-v','error','-y','-f',format[0],'-ar','8000','-ac',String(channels),'-i',join(root,source),'-c:a','copy',join(root,input)]).status).toBe(0);
      for(const [container,extension]of [['wav','wav'],[format[0],'pcm'],['framecrc','crc']] as const){
        const outputs:Output[]=[];
        for(const [index,transform]of transforms.entries())for(const selection of selections)outputs.push({after:['-af',`biquad=${sets(transform)[index%3]}:a=${transform}:r=${precisions[index%5]}`,...selection,'-c:a',format[1],'-bitexact','-f',container],label:`${input}/${container}/${transform}/${selection.join(' ')}`});
        count+=await batch(root,frontend,input,['-cpuflags','0'],outputs,extension);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(count).toBe(1080);
},600000);
it.skipIf(!linux)('matches native with asetnsamples=7 and =8 before biquad, volume after it and aformat before it',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-biquad-chains-');let count=0;
  try{
    for(const format of [formats[1],formats[2],formats[3],formats[4]])for(const channels of [1,2]){
      const input=`input-${format[0]}-${channels}.raw`,before=raw(format,44100,channels);writeFileSync(join(root,input),pcm(format[2],format[0].startsWith('f'),5000*channels,3));
      const outputs:Output[]=[];
      for(const transform of transforms)for(const precision of precisions){
        const filter=`biquad=${sets(transform)[3]}:a=${transform}:r=${precision}`;
        // Frame grouping must not change the output: the two regroupings agree with each other and with native.
        const seven=md5(root,before,input,`asetnsamples=n=7:p=0,${filter}`),eight=md5(root,before,input,`asetnsamples=n=8:p=0,${filter}`);expect(seven,filter).toBe(eight);
        for(const chain of [`asetnsamples=n=7:p=0,${filter}`,`asetnsamples=n=8:p=0,${filter}`,`${filter},volume=0.5`,`aformat=sample_fmts=s32,${filter}`,`aformat=sample_fmts=dbl,${filter},volume=2`])outputs.push({after:crc(chain,format[1]),label:`${input}/${chain}`});
      }
      count+=await batch(root,frontend,input,before,outputs);
    }
    // transform=di is refused: native's output depends on the frame grouping.
    writeFileSync(join(root,'di.raw'),pcm(2,false,5000*2,3));const before=raw(formats[1],44100,2),filter='biquad=a1=-1.99:a2=0.995:b0=0.001:b1=0.002:b2=0.001:r=s16';
    expect(md5(root,before,'di.raw',`asetnsamples=n=7:p=0,${filter}`)).not.toBe(md5(root,before,'di.raw',`asetnsamples=n=8:p=0,${filter}`));
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(count).toBe(1200);
},600000);
it('fails explicitly before output where native fails, and for accepted forms that remain unimplemented',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-biquad-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));let index=0;
    const lowpass='a1=-1.143:a2=0.4128:b0=0.0675:b1=0.135:b2=0.0675';
    // [filter, native accepts]: out-of-range values, unknown options, an extra positional value and a positional value after a named one fail natively;
    // di (also by default), blocksize, a channel subset, a0=0, unstable or float-overflowing sets, expressions and timeline enable are accepted natively but refused here.
    const cases:readonly (readonly [string,boolean])[]=[[`biquad=${lowpass}:a=di`,true],[`biquad=${lowpass}`,true],['biquad',true],[`biquad=${lowpass}:a=0`,true],[`biquad=${lowpass}:a=dii:blocksize=64`,true],[`biquad=${lowpass}:a=dii:b=1`,true],
      [`biquad=${lowpass}:a=dii:c=FL`,true],[`biquad=${lowpass}:a=tdii:channels=FL+FR`,true],[`biquad=a0=0:${lowpass}:a=dii`,true],['biquad=a1=-2:a2=1:b0=1:a=dii',true],['biquad=a1=0.5:a2=-1.2:b0=1:a=tdii',true],['biquad=a1=-1.6:a2=0.5:b0=1:a=latt',true],
      [`biquad=a0=1:${lowpass}:a=zdf`,true],['biquad=a0=1e-30:b0=2000000000:a=dii',true],[`biquad=${lowpass}:a=dii:enable=1`,true],['biquad=a1=-1/2:b0=1:a=dii',true],['biquad=a1=0.5:b0=1:a=dii:n=yes',true],['biquad=a1=0.5:b0=1:a=dii:r=2+1',true],
      ['biquad=a1=0.5:b0=3000000000:a=dii',false],['biquad=a1=0.5:b0=1:mix=1.5:a=dii',false],['biquad=a1=0.5:b0=1:mix=-0.1:a=dii',false],[`biquad=${lowpass}:a=dii:blocksize=40000`,false],[`biquad=${lowpass}:a=foo`,false],[`biquad=${lowpass}:a=dii:r=s8`,false],
      [`biquad=${lowpass}:a=dii:foo=1`,false],['biquad=1:0:0:1:0:0:1:all:0:1:-1:0:9',false],['biquad=a1=0.5:0.3',false],[`biquad=${lowpass}:a=dii:a=7`,false],[`biquad=${lowpass}:a=dii:r=4`,false]];
    for(const [filter,nativeAccepts]of cases){
      const before=['-cpuflags','0','-f','s16le','-ar','8000','-ac','2'],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw','-af',filter,'-f','framecrc',out]);
      const status=spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),'-af',filter,'-f','framecrc','-']).status;
      expect(status===0,filter).toBe(nativeAccepts);expect(result.exitCode,filter).not.toBe(0);expect(result.diagnostics.at(-1)?.message,filter).toMatch(/biquad/);expect(existsSync(join(root,out.slice(1))),filter).toBe(false);
    }
    // The default transform is refused with the frame-boundary message.
    const bare=await frontend.exec(['-f','s16le','-ar','8000','-ac','2','-i','/input.raw','-af',`biquad=${lowpass}`,'-f','framecrc','/bare.crc']);
    expect(bare.diagnostics.at(-1)?.message).toBe('biquad transform di depends on native frame boundaries, which are not implemented');
    // Native resamples around biquad; automatic rate conversion with a native format list is not implemented.
    const resampled=await frontend.exec(['-f','s16le','-ar','8000','-ac','2','-i','/input.raw','-af',`biquad=${lowpass}:a=dii`,'-ar','16000','-f','framecrc','/resampled.crc']);
    expect(spawnSync(native,['-v','error','-f','s16le','-ar','8000','-ac','2','-i',join(root,'input.raw'),'-af',`biquad=${lowpass}:a=dii`,'-ar','16000','-f','framecrc','-']).status).toBe(0);
    expect(resampled.exitCode).not.toBe(0);expect(resampled.diagnostics.at(-1)?.message).toMatch(/biquad/);expect(existsSync(join(root,'resampled.crc'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
