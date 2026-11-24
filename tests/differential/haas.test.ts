import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg'),linux=process.platform==='linux'&&process.arch==='x64';
const sources=[['u8',1],['s16le',2],['s32le',4],['f32le',4],['f64le',8]] as const,outputs=[['f64le','pcm_f64le'],['f32le','pcm_f32le'],['s16le','pcm_s16le']] as const;
/** Deterministic interleaved PCM: integer formats use every byte pattern, floating formats stay finite in [-1,1] and include -0. */
function pcm(width:number,floating:boolean,count:number):Uint8Array {
  const data=new Uint8Array(count*width),view=new DataView(data.buffer);
  for(let i=0;i<count;i++){if(!floating)for(let b=0;b<width;b++)view.setUint8(i*width+b,(i*73+b*151+37)&255);else{const value=i===0?-0:Math.sin(i*0.731)*((i%13)/12);if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}}
  return data;
}
async function harness(prefix:string,budget=1<<18){
  const root=mkdtempSync(join(tmpdir(),prefix)),filesystem=await createNodeFileSystem({root,maxReadBytes:1<<20,maxWriteBytes:1<<20});
  return {root,frontend:new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:1<<23,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:20000}})};
}
/** Runs native and ours on the same arguments; returns both outputs (ours null when it failed). */
async function compare(root:string,frontend:FFmpeg,before:readonly string[],after:readonly string[],out:string){
  const expected=execFileSync(native,['-v','error','-y',...before.map(arg=>arg.startsWith('/')?join(root,arg.slice(1)):arg),...after,join(root,`native-${out}`)],{maxBuffer:1<<26});
  expect(expected.length).toBe(0);
  const result=await frontend.exec([...before,...after,`/${out}`]);
  expect(result.exitCode,JSON.stringify({before,after,diagnostics:result.diagnostics})).toBe(0);
  return {ours:readFileSync(join(root,out)),theirs:readFileSync(join(root,`native-${out}`))};
}
const sweep=['haas','haas=middle_source=left','haas=middle_source=right','haas=middle_source=mid','haas=middle_source=side','haas=middle_phase=1','haas=left_phase=1:right_phase=0','haas=left_phase=true:right_phase=false:middle_phase=on',
  'haas=left_balance=0:right_balance=0','haas=left_balance=1:right_balance=-1','haas=left_balance=0.3:right_balance=-0.7:left_gain=2.5:right_gain=0.015625',
  'haas=left_delay=0:right_delay=0','haas=left_delay=2.05:right_delay=2.05','haas=left_delay=40:right_delay=0','haas=left_delay=0:right_delay=40','haas=left_delay=40:right_delay=40','haas=left_delay=0.01:right_delay=39.999',
  'haas=level_in=0.015625:level_out=64:side_gain=64','haas=level_in=3:level_out=0.25:side_gain=0.5','haas=2:0.5:1.5:side:1:7.5:0.25:3:1:13:-0.5:0.75:0',
  'haas=middle_source=3:middle_phase=yes:left_delay=1.7:left_balance=-0.2:left_gain=1.1:right_delay=33.3:right_balance=0.9:right_gain=4:level_in=0.9:level_out=1.3:side_gain=0.8'];
it.runIf(linux)('matches native PCM bytes for every option sweep at 8000/44100/48000 Hz, stereo from every source format into f64/f32/s16',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-haas-');
  let compared=0,index=0;
  try{
    for(const [raw,width]of sources){
      writeFileSync(join(root,`${raw}.raw`),pcm(width,raw.startsWith('f'),5000*2));
      for(const rate of [8000,44100,48000])for(const chain of sweep)for(const [format,codec]of raw==='f64le'||chain==='haas'||chain.startsWith('haas=2:')?outputs:[outputs[0]]){
        const {ours,theirs}=await compare(root,frontend,['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac','2','-i',`/${raw}.raw`],['-af',chain,'-c:a',codec,'-f',format],`${index++}.${format}`);
        expect(ours.equals(theirs),`${raw}/${rate}/${chain}/${format}`).toBe(true);compared++;
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  // Per rate: f64 input into all three outputs (63), each other source into f64 plus f32/s16 for the defaults and the positional form (25).
  expect(compared).toBe(3*(63+4*25));
},600000);
it.runIf(linux)('matches native framecrc across frame splits, WAV input, output selection and frame limits, and at rates where native wraps its power-of-two ring',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-haas-crc-');
  let compared=0,index=0;
  try{
    for(const [raw,width]of [sources[1],sources[4]]){
      writeFileSync(join(root,`${raw}.raw`),pcm(width,raw.startsWith('f'),7000*2));
      execFileSync(native,['-v','error','-y','-f',raw,'-ar','44100','-ac','2','-i',join(root,`${raw}.raw`),'-c:a','copy',join(root,`${raw}.wav`)]);
      const chains=['haas','asetnsamples=7:p=0,haas=left_delay=40:right_delay=1','asetnsamples=1000,haas=middle_source=side:left_delay=0.5,asetnsamples=333:p=0','haas,haas=middle_phase=1','volume=0.5,haas=left_balance=0.1,aformat=fltp'];
      const profiles:[string[],string[]][]=[[[],[]],[['-ss','0.01'],[]],[[],['-ss','0.05']],[[],['-t','0.02']],[[],['-frames:a','2']],[['-t','0.1'],['-ss','0.003','-t','0.05']]];
      for(const input of [['-f',raw,'-ar','44100','-ac','2','-i',`/${raw}.raw`],['-i',`/${raw}.wav`]])for(const chain of chains)for(const [selection,output]of profiles){
        const {ours,theirs}=await compare(root,frontend,['-cpuflags','0',...selection,...input],['-af',chain,...output,'-c:a','pcm_f64le','-bitexact','-f','framecrc'],`${index++}.crc`);
        expect(ours.toString(),`${input.join(' ')}/${chain}/${selection.join(' ')}/${output.join(' ')}`).toBe(theirs.toString());compared++;
      }
    }
    // sample_rate*40 ms is an exact power of two at 6400/12800/25600 Hz: a 40 ms delay reads the ring at the write position.
    writeFileSync(join(root,'wrap.raw'),pcm(8,true,9000*2));
    for(const rate of [1,100,6400,12800,25600,192000])for(const chain of ['haas=left_delay=40:right_delay=39.99','haas=left_delay=39.999:right_delay=40:left_balance=0.5']){
      const {ours,theirs}=await compare(root,frontend,['-cpuflags','0','-f','f64le','-ar',String(rate),'-ac','2','-i','/wrap.raw'],['-af',chain,'-c:a','pcm_f64le','-f','f64le'],`${index++}.f64`);
      expect(ours.equals(theirs),`${rate}/${chain}`).toBe(true);compared++;
    }
  }finally{rmSync(root,{recursive:true,force:true});}
  expect(compared).toBe(2*2*5*6+12);
},600000);
it('refuses mono, three-channel, out-of-range and unimplemented forms before output, beside native status',async()=>{
  const {root,frontend}=await harness('edgeffmpeg-haas-refuse-');
  try{
    writeFileSync(join(root,'in.raw'),pcm(2,false,600*6));
    // [channels, filter, native status, our message]: native converts mono and three channels implicitly; 222 is ERANGE, 234 EINVAL, 8 option not found.
    const cases:[number,string,number,string][]=[
      [1,'haas',0,'haas requires a stereo layout'],[3,'haas',0,'haas requires a stereo layout'],[1,'haas=middle_source=left',0,'haas requires a stereo layout'],
      [2,'haas=level_in=0',222,'Value 0 for haas option level_in out of range [0.015625 - 64]'],[2,'haas=level_out=64.5',222,'Value 64.5 for haas option level_out out of range [0.015625 - 64]'],
      [2,'haas=side_gain=0.015624',222,'Value 0.015624 for haas option side_gain out of range [0.015625 - 64]'],[2,'haas=left_delay=40.001',222,'Value 40.001 for haas option left_delay out of range [0 - 40]'],
      [2,'haas=right_delay=-1',222,'Value -1 for haas option right_delay out of range [0 - 40]'],[2,'haas=left_balance=1.5',222,'Value 1.5 for haas option left_balance out of range [-1 - 1]'],
      [2,'haas=right_gain=1e400',222,'Value 1e400 for haas option right_gain out of range [0.015625 - 64]'],[2,'haas=middle_source=4',222,'Value 4 for haas option middle_source out of range [0 - 3]'],
      [2,'haas=middle_phase=2',234,'Unable to parse haas option middle_phase value 2 as boolean'],[2,'haas=left_phase=auto',234,'Unable to parse haas option left_phase value auto as boolean'],
      [2,'haas=foo=1',8,'Unsupported haas option: foo'],[2,'haas=1:level_out=2:3',234,'No haas option name near 3'],[2,'haas=1:1:1:1:1:1:1:1:1:1:1:1:1:1',234,'Too many haas option values near 1'],
      [2,'haas=level_in=nan',234,'Only constant decimal values are implemented for haas option level_in'],
      // Accepted natively, refused here: expressions, fractional integer options and quoting.
      [2,'haas=level_in=1+1',0,'Only constant decimal values are implemented for haas option level_in'],[2,'haas=middle_source=1.5',0,'Only left, right, mid, side or an integer are implemented for haas option middle_source'],
      [2,'haas=middle_phase=0.0',234,'Only 0, 1 and boolean names are implemented for haas option middle_phase'],[2,"haas=level_in='2'",0,'Quoted or escaped haas options are not implemented']];
    let index=0;
    for(const [channels,chain,status,message]of cases){
      const args=['-f','s16le','-ar','8000','-ac',String(channels),'-i','/in.raw','-af',chain,'-f','f64le'];
      const run=spawnSync(native,['-v','error','-y',...args.map(arg=>arg==='/in.raw'?join(root,'in.raw'):arg),join(root,`native-${index}.raw`)],{encoding:'utf8'});
      expect(run.status,`${chain} ${run.stderr}`).toBe(status);
      const out=`${index++}.raw`,result=await frontend.exec([...args,`/${out}`]);
      expect(result.exitCode,chain).not.toBe(0);expect(existsSync(join(root,out)),chain).toBe(false);
      expect(result.diagnostics[0]?.message,chain).toBe(message);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
