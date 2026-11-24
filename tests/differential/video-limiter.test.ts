import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const;
/** Structured ramps and extremes in even bytes, LCG noise in odd bytes. */
const pattern=(bytes:number,salt:number)=>{let seed=salt*7919+17;return Uint8Array.from({length:bytes},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return i%2?seed>>>24:i%10===0?0:i%10===2?255:(i*37+salt*13)&255;});};
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const media=(arithmetic:PixelArithmetic)=>createMediaBackend({pixelArithmetic:arithmetic});
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const pairs=[[null,null],[16,235],[0,0],[255,255],[128,128],[300,400],[100,300],[65535,65535],[200,100],[256,255]] as const;
it('matches native linear limiter bounds, plane masks and min > max refusals across every declared format',()=>{
 referencePixelArithmetic();const root=mkdtempSync(join(tmpdir(),'edge-limiter-helper-'));let accepted=0,rejected=0;
 try{
  for(const format of formats)for(const [width,height]of [[5,3],[6,4]] as const){
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(frameBytes*2,width+height),file=join(root,'input.raw');writeFileSync(file,input);
   const frames=[0,1].map(n=>decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536}));
   for(const [min,max]of pairs)for(const planes of [0,1,2,5,8,15]){
    const description=`limiter=${min===null?'':`min=${min}:max=${max}:`}planes=${planes}`,label=`${format}/${width}x${height}/${description}`;
    const native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-'],{timeout:10000});expect(native.error,label).toBeUndefined();
    let actual:Buffer|null=null;
    try{const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'});expect(plan.pixelFormat,label).toBe(format);actual=Buffer.concat(frames.flatMap(frame=>plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}).planes));}catch(error){expect((error as Error).message,label).toBe('Limiter min must not exceed max');}
    expect(actual!==null,label).toBe(native.status===0);
    if(actual){expect(actual,label).toEqual(native.stdout);accepted++;}else{expect(native.stdout.length,label).toBe(0);rejected++;}
   }
  }
  expect([accepted,rejected]).toEqual([576,144]);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native limiter CLI rawvideo and framecrc on the linear path, including implicit conversions',async()=>{
 referencePixelArithmetic();let count=0;
 for(const [source,width,height]of [['gray',5,3],['yuv420p',5,3],['yuv422p',6,4],['yuv444p',5,3],['yuva420p',6,4],['gbrp',5,3],['nv12',6,4],['rgb24',5,3]] as const){
  const input=pattern(pixelLayout(source,width,height).bytes*3,width*height),files=new Map([['/in',input]]),root=mkdtempSync(join(tmpdir(),'edge-limiter-cli-'));
  try{writeFileSync(join(root,'input.raw'),input);
   for(const description of ['limiter','limiter=16:235','limiter=300:400:5','limiter=min=40:max=200:planes=8,hflip','vflip,limiter=7:7:2'])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`],after=['-vf',description,'-bitexact','-f',format],native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(files,media('scalar'),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 expect(count).toBe(80);
},120000);
it('matches native limiter filter_complex branches on the graph path in rawvideo and framecrc',async()=>{
 referencePixelArithmetic();let count=0;
 for(const [source,width,height]of [['gray',5,3],['yuva420p',6,4],['gbrp',5,3],['nv12',6,4]] as const){
  const input=pattern(pixelLayout(source,width,height).bytes*3,width+7),files=new Map([['/in',input]]),root=mkdtempSync(join(tmpdir(),'edge-limiter-graph-'));
  try{writeFileSync(join(root,'input.raw'),input);
   for(const description of ['[0:v]split[a][b];[a]limiter=16:235[left];[b]limiter=0:100:1,hflip[right]','[0:v]limiter=min=300,split[left][right]'])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,'-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontend(files,media('scalar'),path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);const label=`${source}/${description}/${format}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),`${label}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}count++;
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 expect(count).toBe(16);
},120000);
it('matches native limiter on the stream path through replay execution and the multi-input CLI',async()=>{
 referencePixelArithmetic();const root=mkdtempSync(join(tmpdir(),'edge-limiter-stream-'));let checked=0;
 try{
  for(const [source,target]of [['yuva420p',null],['gbrp','gbrp'],['yuv422p','yuv422p']] as const){
   const frameBytes=pixelLayout(source,5,3).bytes,input=pattern(frameBytes*3,frameBytes),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]limiter=16:235:5[out]','[in]split[x][y];[x]limiter=50:60[l];[y]limiter=planes=0,hflip[r];[l][r]hstack[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  const left=pattern(pixelLayout('gray',5,3).bytes*3,3),right=pattern(pixelLayout('gray',5,3).bytes*3,4),files=new Map([['/a',left],['/b',right]]);writeFileSync(join(root,'a.raw'),left);writeFileSync(join(root,'b.raw'),right);
  for(const format of ['rawvideo','framecrc']){
   const input=(path:string)=>['-f','rawvideo','-pixel_format','gray','-s','5x3','-i',path],after=['-filter_complex','[0:v]limiter=16:235[a];[1:v]limiter=max=40,vflip[b];[a][b]vstack[out]','-map','[out]','-bitexact','-f',format];
   const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...input(join(root,'a.raw')),...input(join(root,'b.raw')),...after,'-']),sink=collectingOutput();
   const result=await frontend(files,media('scalar'),()=>sink.output).exec([...input('/a'),...input('/b'),...after,'/out']);expect(result.exitCode,format+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),format).toEqual(native);checked++;
  }
  expect(checked).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native limiter through the timed backend on the actor and timed paths in rawvideo and framecrc',async()=>{
 referencePixelArithmetic();const root=mkdtempSync(join(tmpdir(),'edge-limiter-timed-'));let count=0;
 try{
  for(const [source,width,height]of [['gray',5,3],['yuv420p',6,4],['gbrp',5,3]] as const){
   const input=pattern(pixelLayout(source,width,height).bytes*3,width*31),files=new Map([['/in',input]]);writeFileSync(join(root,'input.raw'),input);
   for(const description of ['limiter=16:235','limiter=min=300:planes=5,hflip'])for(const format of ['rawvideo','framecrc'])for(const scheduler of ['producer','pull'] as const){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-vf',description,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format];
    const native=execFileSync(ffmpeg,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(files,timed(scheduler),()=>sink.output).exec(['-y',...before,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}/${scheduler}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed,label).toBe(true);count++;
   }
  }
  expect(count).toBe(24);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails like native for limiter min > max before opening any output on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-limiter-reject-'));let count=0;
 try{
  const input=pattern(pixelLayout('gray',5,3).bytes*2,1),files=new Map([['/in',input],['/b',input]]);writeFileSync(join(root,'input.raw'),input);
  const source=(path:string)=>['-f','rawvideo','-pixel_format','gray','-video_size','5x3','-framerate','25','-i',path];
  const cases:readonly (readonly [string,readonly string[],ExecutionBackend])[]=[
   ['linear',['-vf','limiter=200:100','-f','rawvideo','OUT0'],media('scalar')],
   ['linear-chain',['-vf','hflip,limiter=min=256:max=255','-f','framecrc','OUT0'],media('scalar')],
   ['graph',['-filter_complex','[0:v]split[a][b];[a]limiter=1:0[l];[b]null[r]','-map','[l]','-f','rawvideo','OUT0','-map','[r]','-f','rawvideo','OUT1'],media('scalar')],
   ['stream',['-filter_complex','[0:v]limiter=9:8[a];[1:v]null[b];[a][b]hstack[out]','-map','[out]','-f','rawvideo','OUT0'],media('scalar')],
   ['actor',['-vf','limiter=65535:0','-c:v','rawvideo','-f','framecrc','OUT0'],timed('producer')],
   ['timed',['-vf','limiter=65535:0','-c:v','rawvideo','-f','framecrc','OUT0'],timed('pull')],
  ];
  for(const [path,after,backend]of cases){
   const inputs=path==='stream'?[...source(join(root,'input.raw')),...source(join(root,'input.raw'))]:source(join(root,'input.raw'));
   const native=spawnSync(ffmpeg,['-y','-v','error',...inputs,...after.map(value=>value.startsWith('OUT')?join(root,value):value)],{timeout:10000});expect(native.status,path).not.toBe(0);
   for(const name of ['OUT0','OUT1'])expect(existsSync(join(root,name)),path).toBe(false);
   let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...(path==='stream'?[...source('/in'),...source('/b')]:source('/in')),...after.map(value=>value.startsWith('OUT')?'/'+value:value)]);
   expect(result.exitCode,path).not.toBe(0);expect(opened,path).toBe(0);expect(JSON.stringify(result.diagnostics),path).toContain('Limiter min must not exceed max');count++;
  }
  expect(count).toBe(6);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
