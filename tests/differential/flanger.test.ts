import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {arch,platform,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
/** macOS contracts d*(max-min)+min, the interpolation polynomial and in*in_gain + delayed*delay_gain into FMA: the double cases are linux/x64-only. */
const linux=platform()==='linux'&&arch()==='x64';
/** The reference is built at test time from the fixed commit without x86 assembly; its binary hash is not pinned. */
function reference(){
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:string[]};
  expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');
}
/** Deterministic PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,buffer=1<<22){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:1<<23,maxWriteBytes:1<<23});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<25,maxBufferBytes:buffer,maxPendingPackets:2,maxCpuTimeMs:60000}})};
}
type Frontend=Awaited<ReturnType<typeof harness>>['frontend'];
let counter=0;
async function compare(root:string,frontend:Frontend,input:string,before:readonly string[],after:readonly string[],label:string){
  const expected=execFileSync(native,['-v','error',...before,'-i',join(root,input),...after,'-'],{maxBuffer:1<<26}),out=`/${counter++}.out`,result=await frontend.exec([...before,'-i',`/${input}`,...after,out]);
  expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);
  expect(readFileSync(join(root,out.slice(1))).equals(expected),label).toBe(true);
  return expected;
}
const raw=(name:string,rate:number,channels:number)=>['-cpuflags','0','-f',name,'-ar',String(rate),'-ac',String(channels)];
// Sweeps of every option: delay 0/5/30, depth 0/2/10, regen -95/0/40/95, width 0/71/100, speed 0.1/0.5/10, phase 0/25/100, both interpolations,
// positional shorthand and a half-sample rint (0.3125 ms is 2.5 samples at 8000 Hz).
const sweeps=['flanger=shape=t','flanger=delay=5:depth=10:regen=40:width=100:speed=10:shape=t:phase=100:interp=quadratic','flanger=30:0:-95:0:0.1:t:0:linear',
  'flanger=delay=0:depth=0:regen=95:width=71:speed=10:shape=triangular:interp=quadratic','flanger=delay=30:depth=10:regen=-95:width=100:speed=0.5:shape=t:phase=25:interp=quadratic',
  'flanger=delay=5:depth=2:regen=0:width=71:speed=0.1:shape=t:phase=100','flanger=delay=0.3125:depth=10:regen=95:width=100:speed=10:shape=t:phase=0:interp=linear','flanger=delay=0:depth=10:regen=40:width=0:speed=0.5:shape=t:phase=25:interp=quadratic'];
it.runIf(linux)('matches native framecrc across sources, channel counts, rates and option sweeps into source and f64 outputs',async()=>{
  reference();const {root,frontend}=await harness('edgeffmpeg-flanger-');
  try{
    for(const [name,codec,width]of formats)for(const channels of [1,2,3])for(const rate of [8000,44100]){
      writeFileSync(join(root,'input.raw'),pcm(width,name.startsWith('f'),2500*channels));
      for(const target of [...new Set([codec,'pcm_f64le'])])for(const chain of sweeps)
        await compare(root,frontend,'input.raw',raw(name,rate,channels),['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],`${name}/${channels}/${rate}/${target}/${chain}`);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.runIf(linux)('matches native composed chains, frame grouping and output -ss/-t/-frames:a',async()=>{
  reference();const {root,frontend}=await harness('edgeffmpeg-flanger-chains-');
  const profiles:readonly (readonly string[])[]=[[],['-ss','0.1'],['-t','0.2'],['-ss','0.05','-t','0.3'],['-frames:a','2'],['-frames:a','1'],['-ss','0.2','-frames:a','3']];
  const chains=['flanger=delay=5:depth=10:regen=40:speed=10:shape=t:phase=100','asetnsamples=7,flanger=delay=5:regen=-40:shape=t:interp=quadratic','flanger=regen=95:speed=10:shape=t,volume=0.5',
    'flanger=delay=2:speed=3:shape=t,apad=pad_len=300:packet_size=70','apad=pad_len=100,flanger=shape=t:interp=quadratic','asetnsamples=n=29:p=0,flanger=delay=1:depth=10:shape=t,volume=2'];
  try{
    for(const [name,codec,width]of [formats[1],formats[4]])for(const channels of [1,2]){
      writeFileSync(join(root,'input.raw'),pcm(width,name.startsWith('f'),9000*channels));
      for(const chain of chains)for(const output of profiles)await compare(root,frontend,'input.raw',raw(name,8000,channels),['-af',chain,...output,'-c:a',codec,'-bitexact','-f','framecrc'],`${name}/${channels}/${chain}/${output.join(' ')}`);
      // Frame grouping: native output does not depend on asetnsamples=n=N:p=0 before flanger, and neither does ours.
      for(const chain of ['flanger=delay=5:depth=10:regen=95:speed=10:shape=t:phase=100:interp=quadratic','flanger=regen=-95:speed=10:shape=t']){
        const whole=await compare(root,frontend,'input.raw',raw(name,8000,channels),['-af',chain,'-c:a','pcm_f64le','-f','f64le'],`${name}/${channels}/${chain}`);
        for(const size of [1,7,29,50])expect((await compare(root,frontend,'input.raw',raw(name,8000,channels),['-af',`asetnsamples=n=${size}:p=0,${chain}`,'-c:a','pcm_f64le','-f','f64le'],`${name}/${channels}/${size}/${chain}`)).equals(whole),`${size}/${chain}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.runIf(linux)('writes native-identical WAV and raw files from WAV and raw inputs, with output time selection',async()=>{
  reference();const {root,frontend}=await harness('edgeffmpeg-flanger-files-');
  try{
    let index=0;
    for(const [name,codec,width]of formats)for(const source of ['raw','wav'])for(const container of ['wav','raw'] as const)for(const output of [[],['-ss','0.05','-t','0.1']]){
      writeFileSync(join(root,'input.raw'),pcm(width,name.startsWith('f'),3000*2));
      const input=source==='raw'?['-f',name,'-ar','8000','-ac','2','-i']:['-i'];
      if(source==='wav')execFileSync(native,['-v','error','-y','-f',name,'-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a','copy',join(root,'input.wav')]);
      const file=`/${index++}.${container==='raw'?'pcm':container}`,expected=join(root,`reference${file.slice(1)}`),after=['-af','flanger=delay=3:depth=5:regen=40:speed=10:shape=t:interp=quadratic',...output,'-c:a',codec,'-bitexact','-f',container==='raw'?name:container];
      execFileSync(native,['-v','error','-y','-cpuflags','0',...input,join(root,`input.${source}`),...after,expected]);
      const result=await frontend.exec(['-cpuflags','0',...input,`/input.${source}`,...after,file]);
      expect(result.exitCode,JSON.stringify({name,source,container,diagnostics:result.diagnostics})).toBe(0);
      expect(readFileSync(join(root,file.slice(1))).equals(readFileSync(expected)),`${name}/${source}/${container}/${output.join(' ')}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native exactly where width=0 leaves the input unchanged, on every platform',async()=>{
  // delay_gain is 0 and in_gain is 1: out = in*1 + delayed*0, which no contraction can change for finite delayed values.
  reference();const {root,frontend}=await harness('edgeffmpeg-flanger-dry-');
  try{
    for(const [name,codec,width]of formats)for(const channels of [1,3]){
      writeFileSync(join(root,'input.raw'),pcm(width,name.startsWith('f'),2000*channels));
      for(const chain of ['flanger=width=0:shape=t','flanger=delay=30:depth=10:regen=95:width=0:speed=10:shape=t:phase=100:interp=quadratic'])for(const output of [[],['-t','0.1']])
        await compare(root,frontend,'input.raw',raw(name,44100,channels),['-af',chain,...output,'-c:a',codec,'-bitexact','-f','framecrc'],`${name}/${channels}/${chain}/${output.join(' ')}`);
    }
    // Configured empty input: no tail, so only the stream header remains.
    writeFileSync(join(root,'empty.raw'),new Uint8Array(0));
    for(const [name,codec]of [formats[1],formats[3]])for(const chain of ['flanger=shape=t','flanger=delay=5:regen=40:shape=t,volume=0.5'])
      await compare(root,frontend,'empty.raw',raw(name,8000,2),['-af',chain,'-c:a',codec,'-bitexact','-f','framecrc'],`empty/${name}/${chain}`);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails explicitly before output where native fails, and for accepted forms that remain unimplemented',async()=>{
  reference();const {root,frontend}=await harness('edgeffmpeg-flanger-errors-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));let index=0;
    const run=async(args:readonly string[],rate=8000)=>{const before=['-cpuflags','0','-f','s16le','-ar',String(rate),'-ac','2'],out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...args,'-f','framecrc',out]);return {result,out,nativeStatus:spawnSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...args,'-f','framecrc','-']).status};};
    // [filter, native accepts]: the sinusoidal default and integer constants run natively but are unimplemented; ranges, unknown options and enable fail natively.
    const cases:readonly (readonly [string,boolean])[]=[['flanger',true],['flanger=shape=s',true],['flanger=shape=sinusoidal:delay=5',true],['flanger=shape=t:shape=s',true],['flanger=shape=1',true],['flanger=shape=t:interp=1',true],['flanger=shape=t:delay=1/2',true],['flanger=shape=t:depth=max',true],
      ['flanger=shape=t:delay=31',false],['flanger=shape=t:delay=-1',false],['flanger=shape=t:depth=11',false],['flanger=shape=t:regen=-96',false],['flanger=shape=t:regen=96',false],['flanger=shape=t:width=101',false],['flanger=shape=t:speed=0.09',false],['flanger=shape=t:speed=11',false],
      ['flanger=shape=t:phase=101',false],['flanger=shape=t:interp=cubic',false],['flanger=shape=t:foo=1',false],['flanger=shape=t:enable=1',false],['flanger=enable=1:shape=t',false],['flanger=0:2:0:71:0.5:t:25:linear:9',false]];
    for(const [chain,nativeAccepts]of cases){
      const {result,out,nativeStatus}=await run(['-af',chain]);
      expect(nativeStatus===0,chain).toBe(nativeAccepts);expect(result.exitCode,chain).not.toBe(0);expect(result.diagnostics.at(-1)?.message,chain).toMatch(/flanger/);expect(existsSync(join(root,out.slice(1))),chain).toBe(false);
    }
    const bare=await run(['-af','flanger']);expect(bare.result.diagnostics.at(-1)?.message).toBe('flanger shape sinusoidal requires unimplemented libm arithmetic');
    // Native resamples around flanger; automatic rate conversion with a native format list is not implemented.
    const resampled=await run(['-af','flanger=shape=t','-ar','16000']);expect(resampled.nativeStatus).toBe(0);expect(resampled.result.exitCode).not.toBe(0);expect(resampled.result.diagnostics.at(-1)?.message).toMatch(/flanger/);expect(existsSync(join(root,resampled.out.slice(1)))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses flanger state above the buffer budget before opening output',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-flanger-budget-',1<<20);
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,64*2));
    // speed=0.1 at 44100 Hz is a 441000-float (1764000-byte) LFO table, beyond 1 MiB of buffer bytes.
    const result=await frontend.exec(['-cpuflags','0','-f','s16le','-ar','44100','-ac','2','-i','/input.raw','-af','flanger=speed=0.1:shape=t','-f','framecrc','/too-large.crc']);
    expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.code).toBe('resource-budget');expect(existsSync(join(root,'too-large.crc'))).toBe(false);
    const fits=await frontend.exec(['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i','/input.raw','-af','flanger=shape=t','-f','framecrc','/fits.crc']);expect(fits.exitCode,JSON.stringify(fits.diagnostics)).toBe(0);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
