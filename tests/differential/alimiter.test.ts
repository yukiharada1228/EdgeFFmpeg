import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {constants,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),metadata=resolve('.build/reference/build-metadata.json');
const sources=[['u8',1],['s16le',2],['s32le',4],['f32le',4],['f64le',8]] as const;
/** The sandbox reference build: the pinned commit without x86 assembly; its binary hash is not pinned. */
function reference(){const build=JSON.parse(readFileSync(metadata,'utf8'));expect(build.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(build.flags).toContain('--disable-x86asm');}
/** One value in [-1.5,1.5] per sample index and channel: a quiet sine below every limit, noise above it, isolated bursts in silence and
 * alternating rising peaks, so lookahead chains (nextpos) form, extend and drain. */
function signal(i:number,c:number):number {
  const segment=Math.floor(i/1500)%4,k=i%1500,noise=Math.sin(i*12.9898+c*78.233)*43758.5453;
  if(segment===0)return Math.sin((i+c*7)*0.05)*0.05;
  if(segment===1)return (noise-Math.floor(noise))*2.6-1.3;
  if(segment===2)return k%250===c*3?(k%500?0.9:-1.45):k%250===c*3+1?0.4:0;
  return (k%2?-1:1)*Math.min(1.5,0.05+(k%300)*0.005)*(1+c*0.1);
}
/** Interleaved raw PCM of `count` samples per channel; integer formats saturate the [-1,1] scaling, floats keep values above 1. */
function pcm(raw:string,width:number,count:number,channels:number):Uint8Array {
  const data=new Uint8Array(count*channels*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++)for(let c=0;c<channels;c++){
    const value=i===0&&c===0?-0:signal(i,c),index=(i*channels+c)*width,clip=Math.max(-1,Math.min(1,value));
    if(raw==='u8')view.setUint8(index,Math.max(0,Math.min(255,Math.round(clip*127+128))));
    else if(raw==='s16le')view.setInt16(index,Math.max(-32768,Math.min(32767,Math.round(clip*32767))),true);
    else if(raw==='s32le')view.setInt32(index,Math.max(-2147483648,Math.min(2147483647,Math.round(clip*2147483647))),true);
    else if(raw==='f32le')view.setFloat32(index,value,true);else view.setFloat64(index,value,true);
  }
  return data;
}
async function harness(prefix:string,budget=1<<20){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:1<<21,maxWriteBytes:1<<22});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<24,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:60000}})};
}
/** Runs native and ours on the same arguments; returns both outputs. */
async function compare(root:string,frontend:FFmpeg,before:readonly string[],after:readonly string[],out:string){
  const expected=execFileSync(native,['-v','error','-y',...before.map(arg=>arg.startsWith('/')?join(root,arg.slice(1)):arg),...after,join(root,`native-${out}`)],{maxBuffer:1<<26});
  expect(expected.length).toBe(0);
  const result=await frontend.exec([...before,...after,`/${out}`]);
  expect(result.exitCode,JSON.stringify({before,after,diagnostics:result.diagnostics})).toBe(0);
  return {ours:readFileSync(join(root,out)),theirs:readFileSync(join(root,`native-${out}`))};
}
const sweep=['alimiter','alimiter=limit=0.0625','alimiter=limit=0.3','alimiter=limit=1:level=0','alimiter=limit=0.3:level=0','alimiter=attack=0.2:limit=0.5','alimiter=attack=0.37:release=1','alimiter=attack=80:release=8000:limit=0.2',
  'alimiter=release=1:limit=0.0625:attack=2','alimiter=release=8000','alimiter=level_in=4:level_out=0.5:limit=0.4','alimiter=level_in=0.015625:level_out=64:limit=0.0625','alimiter=asc=0:asc_level=1:latency=0:limit=0.25',
  'alimiter=1.5:0.75:0.2:13:300:0:0:1:0','alimiter=level=false:limit=0.7:attack=1.3:release=7'];
it('matches native PCM bytes for the option sweeps on 1-3 channels at 8000/44100/48000 Hz from every raw source format',async()=>{
  reference();
  const {root,frontend}=await harness('edgeffmpeg-alimiter-');
  let compared=0,index=0;
  try{
    for(const [raw,width]of sources)for(const channels of [1,2,3]){
      writeFileSync(join(root,`${raw}-${channels}.raw`),pcm(raw,width,6000,channels));
      for(const rate of [8000,44100,48000]){
        const chains=[...sweep,...(rate===8000?[]:['alimiter=attack=0.1:limit=0.2'])];
        for(const chain of chains)for(const [format,codec]of chain==='alimiter'||chain===sweep[2]?[['f64le','pcm_f64le'],['s16le','pcm_s16le'],['wav','pcm_s32le']] as const:[['f64le','pcm_f64le']] as const){
          const {ours,theirs}=await compare(root,frontend,['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac',String(channels),'-i',`/${raw}-${channels}.raw`],['-af',chain,'-c:a',codec,'-f',format,...(format==='wav'?['-bitexact']:[])],`${index++}.${format}`);
          expect(ours.equals(theirs),`${raw}/${channels}/${rate}/${chain}/${format}`).toBe(true);compared++;
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  // 5 sources x 3 channel counts x 3 rates: 15 chains (attack=0.1 adds one above 8000 Hz), two of them also into s16 and WAV s32.
  expect(compared).toBe(5*3*(3*(15+2*2)+2));
},600000);
it('matches native framecrc across frame splits, chains, WAV input, output selection and frame limits; native output is independent of frame grouping',async()=>{
  reference();
  const {root,frontend}=await harness('edgeffmpeg-alimiter-crc-');
  let compared=0,index=0;
  try{
    for(const [raw,width,channels,rate]of [['s16le',2,2,44100],['f64le',8,1,48000],['f32le',4,3,8000]] as const){
      writeFileSync(join(root,`${raw}.raw`),pcm(raw,width,7000,channels));
      execFileSync(native,['-v','error','-y','-f',raw,'-ar',String(rate),'-ac',String(channels),'-i',join(root,`${raw}.raw`),'-c:a',raw==='f32le'?'pcm_f32le':raw==='f64le'?'pcm_f64le':'pcm_s16le',join(root,`${raw}.wav`)]);
      const chains=['alimiter=limit=0.3','asetnsamples=7,alimiter=limit=0.2:attack=3','asetnsamples=n=7:p=0,alimiter=limit=0.0625:release=1','volume=0.5,alimiter=limit=0.25:level_in=3','alimiter=limit=0.4:level=0,apad=pad_len=300','alimiter=attack=20:limit=0.5,alimiter=limit=0.3:attack=1'];
      const profiles:[string[],string[]][]=[[[],[]],[['-ss','0.01'],[]],[[],['-ss','0.05']],[[],['-t','0.02']],[[],['-frames:a','2']],[['-t','0.1'],['-ss','0.003','-t','0.05']]];
      for(const input of [['-f',raw,'-ar',String(rate),'-ac',String(channels),'-i',`/${raw}.raw`],['-i',`/${raw}.wav`]])for(const chain of chains)for(const [selection,output]of profiles){
        const {ours,theirs}=await compare(root,frontend,['-cpuflags','0',...selection,...input],['-af',chain,...output,'-c:a','pcm_f64le','-bitexact','-f','framecrc'],`${index++}.crc`);
        expect(ours.toString(),`${input.join(' ')}/${chain}/${selection.join(' ')}/${output.join(' ')}`).toBe(theirs.toString());compared++;
      }
      // Raw and WAV outputs (s16 through -cpuflags 0) with output time selection and a frame limit.
      for(const input of [['-f',raw,'-ar',String(rate),'-ac',String(channels),'-i',`/${raw}.raw`],['-i',`/${raw}.wav`]])for(const chain of chains.slice(0,2))for(const [format,codec]of [['f64le','pcm_f64le'],['wav','pcm_s16le']] as const)for(const output of [['-ss','0.02','-t','0.04'],['-frames:a','1']]){
        const {ours,theirs}=await compare(root,frontend,['-cpuflags','0',...input],['-af',chain,...output,'-c:a',codec,'-bitexact','-f',format],`${index++}.${format}`);
        expect(ours.equals(theirs),`${input.join(' ')}/${chain}/${format}/${output.join(' ')}`).toBe(true);compared++;
      }
      // Frame grouping: native samples are identical for 1/7/29/50-sample frames (p=0 keeps the count) and the default grouping; ours equal them.
      const base=['-f',raw,'-ar',String(rate),'-ac',String(channels),'-i',join(root,`${raw}.raw`)],hash=(chain:string)=>execFileSync(native,['-v','error','-cpuflags','0',...base,'-af',chain,'-f','md5','-']).toString();
      const plain=hash('alimiter=limit=0.2:attack=7');
      for(const n of [1,7,29,50]){
        expect(hash(`asetnsamples=n=${n}:p=0,alimiter=limit=0.2:attack=7,asetnsamples=n=4096:p=0`),`native ${n}`).toBe(hash('alimiter=limit=0.2:attack=7,asetnsamples=n=4096:p=0'));
        const {ours,theirs}=await compare(root,frontend,['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac',String(channels),'-i',`/${raw}.raw`],['-af',`asetnsamples=n=${n}:p=0,alimiter=limit=0.2:attack=7`,'-c:a','pcm_f64le','-f','f64le'],`${index++}.f64`);
        expect(ours.equals(theirs),`${raw} split ${n}`).toBe(true);compared++;
      }
      expect(plain.length).toBeGreaterThan(0);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(compared).toBe(3*(2*6*6+16+4));
},600000);
it('refuses asc, latency, too small attacks, out-of-range values and enable before output, beside native status',async()=>{
  reference();
  const {root,frontend}=await harness('edgeffmpeg-alimiter-refuse-');
  const status=(errno:number)=>256-errno,{EINVAL,ERANGE}=constants.errno;
  try{
    writeFileSync(join(root,'in.raw'),pcm('s16le',2,600,3));
    // [channels, rate, filter, native status, our message]: native runs asc, latency and enable; option-not-found is AVERROR_OPTION_NOT_FOUND (status 8).
    const cases:[number,number,string,number,string][]=[
      [1,8000,'alimiter=asc=1',0,'alimiter asc requires unimplemented libm arithmetic'],[2,44100,'alimiter=asc=true:asc_level=0.2',0,'alimiter asc requires unimplemented libm arithmetic'],
      [1,8000,'alimiter=latency=1',0,'alimiter latency compensation drops leading samples, which the audio chain cannot express'],[3,48000,'alimiter=1:1:1:5:50:0:0.5:1:1',0,'alimiter latency compensation drops leading samples, which the audio chain cannot express'],
      [1,8000,'alimiter=attack=0.1',status(EINVAL),'alimiter attack is too small'],[2,8000,'alimiter=attack=0.1',status(EINVAL),'alimiter attack is too small'],[3,8000,'alimiter=attack=0.1',status(EINVAL),'alimiter attack is too small'],
      [1,8000,'alimiter=attack=0.12',status(EINVAL),'alimiter attack is too small'],
      [1,8000,'alimiter=enable=1',0,'alimiter timeline enable is not implemented'],[2,8000,"alimiter=limit=0.5:enable='lt(t,1)'",0,'Quoted or escaped alimiter options are not implemented'],
      [1,8000,'alimiter=limit=0.06',status(ERANGE),'Value 0.06 for alimiter option limit out of range [0.0625 - 1]'],[1,8000,'alimiter=limit=1.01',status(ERANGE),'Value 1.01 for alimiter option limit out of range [0.0625 - 1]'],
      [1,8000,'alimiter=attack=0.09',status(ERANGE),'Value 0.09 for alimiter option attack out of range [0.1 - 80]'],[1,8000,'alimiter=attack=81',status(ERANGE),'Value 81 for alimiter option attack out of range [0.1 - 80]'],
      [1,8000,'alimiter=release=0.5',status(ERANGE),'Value 0.5 for alimiter option release out of range [1 - 8000]'],[1,8000,'alimiter=release=8001',status(ERANGE),'Value 8001 for alimiter option release out of range [1 - 8000]'],
      [1,8000,'alimiter=level_in=0.01',status(ERANGE),'Value 0.01 for alimiter option level_in out of range [0.015625 - 64]'],[1,8000,'alimiter=level_out=65',status(ERANGE),'Value 65 for alimiter option level_out out of range [0.015625 - 64]'],
      [1,8000,'alimiter=asc_level=1.5',status(ERANGE),'Value 1.5 for alimiter option asc_level out of range [0 - 1]'],[1,8000,'alimiter=level=2',status(EINVAL),'Unable to parse alimiter option level value 2 as boolean'],
      [1,8000,'alimiter=latency=auto',status(EINVAL),'Unable to parse alimiter option latency value auto as boolean'],[1,8000,'alimiter=foo=1',8,'Unsupported alimiter option: foo'],
      [1,8000,'alimiter=1:1:1:5:50:0:0.5:1:0:1',status(EINVAL),'Too many alimiter option values near 1'],[1,8000,'alimiter=limit=0.5:2',status(EINVAL),'No alimiter option name near 2'],
      // Accepted natively, refused here: expressions.
      [1,8000,'alimiter=limit=1/2',0,'Only constant decimal values are implemented for alimiter option limit']];
    let index=0;
    for(const [channels,rate,chain,expected,message]of cases){
      const args=['-f','s16le','-ar',String(rate),'-ac',String(channels),'-i','/in.raw','-af',chain,'-f','f64le'];
      const run=spawnSync(native,['-v','error','-y',...args.map(arg=>arg==='/in.raw'?join(root,'in.raw'):arg),join(root,`native-${index}.raw`)],{encoding:'utf8'});
      expect(run.status,`${chain} ${run.stderr}`).toBe(expected);
      const out=`${index++}.raw`,result=await frontend.exec([...args,`/${out}`]);
      expect(result.exitCode,chain).not.toBe(0);expect(existsSync(join(root,out)),chain).toBe(false);
      expect(result.diagnostics[0]?.message,chain).toBe(message);
    }
    expect(index).toBe(25);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
