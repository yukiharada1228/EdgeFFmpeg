import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {arch,constants,platform,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),metadata=JSON.parse(readFileSync(resolve('.build/reference/build-metadata.json'),'utf8')) as {commit:string;flags:string[]};
const formats=[['u8','pcm_u8',1],['s16le','pcm_s16le',2],['s32le','pcm_s32le',4],['f32le','pcm_f32le',4],['f64le','pcm_f64le',8]] as const;
// src*in_gain + buffer*decay and the triangle table's d*(max-min)+min: macOS contracts both into FMA, so arbitrary gains run only on Linux x64.
const linux=platform()==='linux'&&arch()==='x64';
/** Deterministic PCM: integer formats use every byte pattern (s32 full scale included), floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,buffer=1<<20){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:1<<23,maxWriteBytes:1<<23});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<24,maxBufferBytes:buffer,maxPendingPackets:2,maxCpuTimeMs:120000}})};
}
type Job={readonly after:readonly string[];readonly label:string};
let serial=0;
/** One native process per input writes every job's output (batched), then EdgeFFmpeg runs each job; outputs compare byte for byte. */
async function compare(root:string,frontend:FFmpeg,before:readonly string[],input:string,jobs:readonly Job[]):Promise<Buffer[]> {
  const args=['-v','error','-y',...before,'-i',join(root,input)],names=jobs.map(()=>serial++);
  jobs.forEach((job,index)=>args.push(...job.after,join(root,`native-${names[index]}.out`)));
  execFileSync(native,args);
  const outputs:Buffer[]=[];
  for(const [index,job]of jobs.entries()){
    const out=`/edge-${names[index]}.out`,result=await frontend.exec([...before,'-i',`/${input}`,...job.after,out]),expected=readFileSync(join(root,`native-${names[index]}.out`));
    expect(result.exitCode,JSON.stringify({label:job.label,diagnostics:result.diagnostics})).toBe(0);
    expect(readFileSync(join(root,out.slice(1))).equals(expected),job.label).toBe(true);outputs.push(expected);
  }
  return outputs;
}
it('runs against a reference built from commit 946fcce0 with --disable-x86asm',()=>{expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');});
// Delay 0.1-5 ms, decay 0-0.99, speed 0.1-2, type=t, positional shorthand, and gains on and just inside native's out_gain bound.
const sweep=['aphaser','aphaser=delay=0.1:decay=0:speed=2','aphaser=in_gain=0.5:out_gain=1:delay=5:decay=0.5:speed=0.1','aphaser=0.01:1:2.5:0.99:1.3:t','aphaser=in_gain=0.6:out_gain=0.66:delay=0.7:decay=0.1:speed=0.7:type=triangular',
  'aphaser=in_gain=1:out_gain=0.999:decay=0:delay=4.2:speed=0.25','aphaser=in_gain=0.3:out_gain=0.533:delay=1.9:decay=0.84:speed=1.95','aphaser=delay=3.3:decay=0.95:in_gain=0.05:out_gain=1:speed=0.45','aphaser=in_gain=0.7:out_gain=0.99:decay=0.3:delay=2.6:speed=0.6'];
const planar=['aformat=sample_fmts=s16p,aphaser','aformat=sample_fmts=s32p,aphaser=0.5:1:1.3:0.5:0.3','aformat=sample_fmts=fltp,aphaser=delay=4:decay=0.7:in_gain=0.3:speed=1','aformat=sample_fmts=dblp,aphaser=0.2:2:0.4:0.6:2','asetnsamples=7,aphaser=delay=2:decay=0.6:in_gain=0.4'];
it.skipIf(!linux)('matches native framecrc for delay, decay, speed and gain sweeps over every native sample format, 1-3 channels at 8000 and 44100 Hz',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aphaser-');
  try{
    let count=0;
    for(const [raw,codec,width]of formats)for(const rate of [8000,44100])for(const channels of [1,2,3]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),12000*channels));
      const jobs:Job[]=[];
      // Native's own encoder format keeps the native pick; s16 (and f64) output adds the float-to-integer (and integer-to-float) conversions.
      for(const chain of [...sweep,...planar])for(const target of new Set([codec,'pcm_s16le',...(channels===2?['pcm_f64le']:[])]))jobs.push({after:['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],label:`${raw}/${rate}/${channels}/${chain}/${target}`});
      count+=(await compare(root,frontend,['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac',String(channels)],'input.raw',jobs)).length;
    }
    expect(count).toBe(868);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.skipIf(!linux)('writes native-identical WAV, raw and framecrc output from raw and WAV input with output -ss, -t and -frames:a, and composes with volume',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aphaser-files-');
  try{
    let count=0;
    for(const [raw,codec,width]of [formats[1],formats[3]]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),12000*2));
      execFileSync(native,['-v','error','-y','-f',raw,'-ar','44100','-ac','2','-i',join(root,'input.raw'),'-c:a',codec,'-bitexact',join(root,'input.wav')]);
      for(const [before,input]of [[['-cpuflags','0','-f',raw,'-ar','44100','-ac','2'],'input.raw'],[['-cpuflags','0'],'input.wav']] as const){
        const jobs:Job[]=[];
        for(const chain of ['aphaser=delay=5:decay=0.9:in_gain=0.1:speed=0.1','aphaser=0.4:0.74:3:0.4:0.5','aphaser=in_gain=0.5:out_gain=1:decay=0.5:delay=0.2:speed=2'])for(const output of [[],['-ss','0.05'],['-t','0.1'],['-frames:a','2'],['-ss','0.02','-t','0.07']])for(const [target,container]of [['pcm_s16le','wav'],[codec,raw],['pcm_f32le','framecrc']]){
          jobs.push({after:['-af',chain,...output,'-c:a',target!,'-bitexact','-f',container!],label:`${raw}/${input}/${chain}/${output.join(' ')}/${container}`});
        }
        count+=(await compare(root,frontend,before,input,jobs)).length;
      }
    }
    // volume=0.5 after aphaser merges {flt,fltp}: u8 and f32 input run aphaser in flt as native does.
    for(const [raw,,width]of [formats[0],formats[3]])for(const channels of [1,3]){
      writeFileSync(join(root,'mixed.raw'),pcm(width,raw.startsWith('f'),5000*channels));
      count+=(await compare(root,frontend,['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],'mixed.raw',['aphaser,volume=0.5','aphaser=0.5:1:0.4:0.5:2,volume=0.5:precision=float'].flatMap(chain=>['pcm_s16le','pcm_f32le'].map(target=>({after:['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],label:`${raw}/${channels}/${chain}/${target}`}))))).length;
    }
    expect(count).toBe(196);
  }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it.skipIf(!linux)('does not depend on frame grouping: asetnsamples=n=1/7/29/50:p=0 before aphaser matches native and ungrouped output byte for byte',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aphaser-grouping-');
  try{
    let count=0;
    for(const [raw,codec,width]of [formats[1],formats[2],formats[3],formats[4]]){
      writeFileSync(join(root,'input.raw'),pcm(width,raw.startsWith('f'),4000*2));
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],chains=['aphaser=delay=1.1:decay=0.7:in_gain=0.25:speed=1.6',...[1,7,29,50].map(n=>`asetnsamples=n=${n}:p=0,aphaser=delay=1.1:decay=0.7:in_gain=0.25:speed=1.6`)];
      const outputs=await compare(root,frontend,before,'input.raw',chains.map(chain=>({after:['-af',chain,'-c:a',codec,'-bitexact','-f',raw],label:`${raw}/${chain}`})));count+=outputs.length;
      for(const output of outputs)expect(output.equals(outputs[0]!),raw).toBe(true);
    }
    expect(count).toBe(20);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native on every platform for integer input with binary-fraction gains at power-of-two modulation lengths, full-scale s32 on the clipping bound included',async()=>{
  // At 8192 Hz with speed 0.5/1/2 the table length is a power of two, so d*(max-min)+min is exact; gains and decays 0.25/0.5/1/2 make every product exact,
  // so no FMA contraction can change the result. G/(1-D) = 1/O puts these chains exactly on native's bound.
  const {root,frontend}=await harness('edgeffmpeg-aphaser-exact-');
  try{
    let count=0;
    const chains=['aphaser=in_gain=0.5:out_gain=1:decay=0.5:delay=3:speed=0.5','aphaser=in_gain=0.25:out_gain=2:decay=0.5:delay=5:speed=2','aphaser=in_gain=1:out_gain=1:decay=0:delay=1:speed=1','aphaser=0.25:1:0.2:0.5:1','asetnsamples=n=7:p=0,aphaser=in_gain=0.25:out_gain=1:decay=0.25:delay=2.5:speed=2','aformat=sample_fmts=s16p,aphaser=0.5:1:4:0.5:0.5'];
    const extremes=(count:number)=>{const data=new Uint8Array(count*4),view=new DataView(data.buffer);for(let i=0;i<count;i++)view.setInt32(i*4,((i>>6)%3===0)?2147483647:((i>>6)%3===1)?-2147483648:(i*7919)|0,true);return data;};
    for(const [raw,codec,data]of [['u8','pcm_u8',pcm(1,false,6000*3)],['s16le','pcm_s16le',pcm(2,false,6000*3)],['s32le','pcm_s32le',pcm(4,false,6000*3)],['s32le','pcm_s32le',extremes(6000*3)]] as const)for(const channels of [1,3]){
      writeFileSync(join(root,'input.raw'),data.subarray(0,data.length/3*channels));
      count+=(await compare(root,frontend,['-f',raw,'-ar','8192','-ac',String(channels)],'input.raw',chains.flatMap(chain=>[codec,'pcm_s32le'].filter((v,i,a)=>a.indexOf(v)===i).map(target=>({after:['-af',chain,'-c:a',target,'-bitexact','-f','framecrc'],label:`${raw}/${channels}/${chain}/${target}`}))))).length;
    }
    writeFileSync(join(root,'empty.raw'),new Uint8Array(0));
    count+=(await compare(root,frontend,['-f','s16le','-ar','8192','-ac','2'],'empty.raw',chains.slice(0,2).map(chain=>({after:['-af',chain,'-c:a','pcm_s16le','-bitexact','-f','framecrc'],label:`empty/${chain}`})))).length;
    expect(count).toBe(74);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('refuses sinusoidal modulation, gains past the clipping bound, delays that round to zero and enable before output, with native status for each case',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-aphaser-refuse-');
  try{
    writeFileSync(join(root,'input.raw'),pcm(2,false,800));let index=0;
    // Native accepts sinusoidal, warns and runs for gains past the bound, fails with EINVAL for a delay that rounds to zero and refuses enable (no timeline support).
    const einval=256-constants.errno.EINVAL;
    const cases:[string,string,number|'nonzero',string][]=[
      ['aphaser=type=s','8000',0,'unsupported-filter'],['aphaser=type=sinusoidal:speed=1','8000',0,'unsupported-filter'],['aphaser=0.4:0.74:3:0.4:0.5:s','44100',0,'unsupported-filter'],
      ['aphaser=in_gain=1:out_gain=1:decay=0.5','8000',0,'unsupported-filter'],['aphaser=in_gain=0.5:out_gain=1.01:decay=0.5','44100',0,'unsupported-filter'],['aphaser=out_gain=1e9','8000',0,'unsupported-filter'],['aphaser=in_gain=0.010001:out_gain=1:decay=0.99','8000',0,'unsupported-filter'],
      ['aphaser=delay=0.05','8000',einval,'execution-failed'],['aphaser=delay=0.01','44100',einval,'execution-failed'],['aphaser=delay=0','8000',einval,'execution-failed'],
      ['aphaser=enable=1','8000','nonzero','unsupported-filter'],["aphaser=enable='between(t,0,1)'",'8000','nonzero','unsupported-filter'],['aphaser=delay=6','8000','nonzero','unsupported-filter'],['aphaser=type=x','8000','nonzero','unsupported-filter']];
    for(const [chain,rate,status,code]of cases){
      const args=['-f','s16le','-ar',rate,'-ac','1','-i'],after=['-af',chain,'-f','s16le'];
      const nativeStatus=spawnSync(native,['-v','error',...args,join(root,'input.raw'),...after,'-y',join(root,'native.raw')]).status;
      if(status==='nonzero')expect(nativeStatus,chain).not.toBe(0);else expect(nativeStatus,chain).toBe(status);
      const out=`/${index++}.raw`,result=await frontend.exec([...args,'/input.raw',...after,out]);
      expect(result.exitCode,chain).not.toBe(0);expect(result.diagnostics.at(-1)?.code,chain).toBe(code);expect(existsSync(join(root,out.slice(1))),chain).toBe(false);
    }
    // volume after aphaser on s16 input: native runs aphaser in flt after merging {flt,fltp}; the chain refuses that negotiation before output.
    const args=['-f','s16le','-ar','8000','-ac','1','-i'],after=['-af','aphaser,volume=0.5','-f','s16le'];
    expect(spawnSync(native,['-v','error',...args,join(root,'input.raw'),...after,'-y',join(root,'native.raw')]).status).toBe(0);
    const result=await frontend.exec([...args,'/input.raw',...after,'/merged.raw']);
    expect(result.exitCode).not.toBe(0);expect(String(result.diagnostics.at(-1)?.message)).toContain('aphaser with s16 input requires unimplemented format negotiation');expect(existsSync(join(root,'merged.raw'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
