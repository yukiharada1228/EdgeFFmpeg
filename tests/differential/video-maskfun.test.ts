import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {parseMaskfunOptions} from '../../packages/avfilter/src/video-ops/maskfun.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const,sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Native at test time: the sandbox build of the pinned commit with x86 assembly disabled, so native runs the C maskfun8/getsum8. */
const reference=()=>{const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');};
/** Three frames: dark (mean below the default sum, with edges above the thresholds), LCG noise with ramps and 0/255 extremes,
 * and constant 255 planes, so the default, sum=255 and sum=0 tests cross the empty-frame threshold on some frames only. */
const pattern=(bytes:number,salt:number)=>{let seed=salt*7919+17;const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
 return Uint8Array.from({length:bytes*3},(_,i)=>{const n=Math.floor(i/bytes),j=i%bytes;return n===0?(j%31===4?200:j%31===7?11:noise()&3):n===1?(j%2?noise():j%10===0?0:j%10===2?255:(j*37+salt*13)&255):255;});};
const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const media=()=>createMediaBackend({pixelArithmetic:'scalar'});
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
const cases=['maskfun','maskfun=low=0:high=255','maskfun=low=100:high=50','maskfun=planes=1','maskfun=planes=5','maskfun=fill=77:sum=0','maskfun=sum=255','maskfun=fill=300:sum=0:planes=2'] as const;
it('matches native linear maskfun thresholds, plane masks and empty frames across every executable format and size',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskfun-linear-'));let count=0,empties=0,kept=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(frameBytes,width*7+height),file=join(root,'input.raw');writeFileSync(file,input);
   const frames=[0,1,2].map(n=>decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536}));
   for(const description of cases){
    const label=`${format}/${width}x${height}/${description}`,native=spawnSync(ffmpeg,['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-'],{timeout:10000});
    expect(native.error,label).toBeUndefined();expect(native.status,label+native.stderr).toBe(0);
    const plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'});expect(plan.pixelFormat,label).toBe(format);
    const outputs=frames.map(frame=>Buffer.concat(plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}).planes));
    expect(Buffer.concat(outputs),label).toEqual(native.stdout);count++;
    // Which frames cross getsum's threshold, from the input: they must be min(fill, 255) on every plane.
    const step=parseMaskfunOptions(description.includes('=')?description.slice(8):null),layout=pixelLayout(format,width,height);
    for(const [n,output]of outputs.entries()){
     const selected=layout.planes.filter((_,index)=>(step.planes>>index&1)===1),total=selected.reduce((sum,plane)=>sum+input.subarray(n*frameBytes+plane.offset,n*frameBytes+plane.offset+plane.bytes).reduce((a,b)=>a+b,0),0);
     if(selected.length&&total>=step.sum*selected.reduce((sum,plane)=>sum+plane.bytes,0)){expect(output.every(value=>value===Math.min(step.fill,255)),label).toBe(true);empties++;}else kept++;
    }
   }
  }
  expect(count).toBe(288);expect([empties,kept]).toEqual([643,221]);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('matches native maskfun CLI rawvideo and framecrc on the linear path with and without -ss/-t, including implicit conversions',async()=>{
 reference();let count=0;
 for(const [source,width,height]of [['gray',5,3],['yuv420p',7,5],['yuv422p',8,6],['yuv444p',2,2],['yuva420p',17,9],['gbrp',1,1],['nv12',6,4],['rgb24',5,3]] as const){
  const input=pattern(pixelLayout(source,width,height).bytes,width*height),files=new Map([['/in',input]]),root=mkdtempSync(join(tmpdir(),'edge-maskfun-cli-'));
  try{writeFileSync(join(root,'input.raw'),input);
   for(const description of ['maskfun','maskfun=low=100:high=50:sum=255','maskfun=fill=77:sum=0','maskfun=planes=5:sum=300,hflip','vflip,maskfun=20:200:2:9:255','maskfun=fill=300:sum=0:planes=6'])for(const format of ['rawvideo','framecrc'])for(const trim of [[],['-ss','0.04','-t','0.04']]){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-framerate','25',...trim],after=['-vf',description,'-bitexact','-f',format],native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(files,media(),()=>sink.output).exec([...before,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}/${trim.join(' ')}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed).toBe(true);count++;
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 expect(count).toBe(192);
},180000);
it('matches native maskfun with default threads and with -filter_threads 1',()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskfun-threads-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[17,9],[64,48]] as const){
   const frameBytes=pixelLayout(format,width,height).bytes,input=pattern(frameBytes,width+height),file=join(root,'input.raw');writeFileSync(file,input);
   const frames=[0,1,2].map(n=>decodeRawVideo({streamIndex:0,data:input.slice(n*frameBytes,(n+1)*frameBytes),pts:BigInt(n),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<16}));
   for(const description of ['maskfun','maskfun=low=100:high=50:sum=255','maskfun=planes=5:sum=255']){
    const run=(threads:readonly string[])=>execFileSync(ffmpeg,['-v','error',...threads,'-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-f','rawvideo','-']),label=`${format}/${width}x${height}/${description}`;
    const many=run([]),one=run(['-filter_threads','1']),plan=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'});
    expect(many,label).toEqual(one);expect(Buffer.concat(frames.flatMap(frame=>plan.apply(frame,{maxFrameBytes:1<<16,maxStateBytes:plan.stateBytes}).planes)),label).toEqual(one);count++;
   }
  }
  expect(count).toBe(36);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native maskfun filter_complex branches on the graph path in rawvideo and framecrc',async()=>{
 reference();let count=0;
 for(const [source,width,height]of [['gray',5,3],['yuva420p',6,4],['gbrp',7,5],['nv12',6,4]] as const){
  const input=pattern(pixelLayout(source,width,height).bytes,width+7),files=new Map([['/in',input]]),root=mkdtempSync(join(tmpdir(),'edge-maskfun-graph-'));
  try{writeFileSync(join(root,'input.raw'),input);
   for(const description of ['[0:v]split[a][b];[a]maskfun[left];[b]maskfun=low=100:high=50:sum=255,hflip[right]','[0:v]maskfun=fill=77:sum=0:planes=1,split[left][right]'])for(const format of ['rawvideo','framecrc']){
    const before=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`],outputs=(prefix:string)=>['left','right'].flatMap((label,index)=>['-map',`[${label}]`,'-bitexact','-f',format,prefix+index+'.out']);
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0',...before,'-i',join(root,'input.raw'),'-filter_complex',description,...outputs(root+'/')]);const sinks=new Map<string,ReturnType<typeof collectingOutput>>();
    const result=await frontend(files,media(),path=>{const sink=collectingOutput();sinks.set(path,sink);return sink.output;}).exec([...before,'-i','/in','-filter_complex',description,...outputs('/')]);const label=`${source}/${description}/${format}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);
    for(const index of [0,1]){const sink=sinks.get(`/${index}.out`)!;expect(sink.committed,label).toBe(true);expect(Buffer.from(sink.bytes()),`${label}/${index}`).toEqual(readFileSync(join(root,index+'.out')));}count++;
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 expect(count).toBe(16);
},120000);
it('matches native maskfun on the stream path through replay execution and the multi-input CLI',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskfun-stream-'));let checked=0;
 try{
  for(const [source,target]of [['yuva420p',null],['gbrp','gbrp'],['yuv422p','yuv422p']] as const){
   const frameBytes=pixelLayout(source,5,3).bytes,input=pattern(frameBytes,frameBytes),file=join(root,'input.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:3},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(let index=0;index<3;index++){signal.throwIfAborted();yield decodeRawVideo({streamIndex:0,data:input.slice(index*frameBytes,(index+1)*frameBytes),pts:BigInt(index),dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:4096});}}};}};
   for(const graph of ['[in]maskfun=low=100:high=50:sum=255:planes=5[out]','[in]split[x][y];[x]maskfun[l];[y]maskfun=fill=77:sum=0,hflip[r];[l][r]hstack[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:4096,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  const left=pattern(pixelLayout('gray',5,3).bytes,3),right=pattern(pixelLayout('gray',5,3).bytes,4),files=new Map([['/a',left],['/b',right]]);writeFileSync(join(root,'a.raw'),left);writeFileSync(join(root,'b.raw'),right);
  for(const format of ['rawvideo','framecrc']){
   const input=(path:string)=>['-f','rawvideo','-pixel_format','gray','-s','5x3','-i',path],after=['-filter_complex','[0:v]maskfun[a];[1:v]maskfun=low=100:high=50:sum=255,vflip[b];[a][b]vstack[out]','-map','[out]','-bitexact','-f',format];
   const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...input(join(root,'a.raw')),...input(join(root,'b.raw')),...after,'-']),sink=collectingOutput();
   const result=await frontend(files,media(),()=>sink.output).exec([...input('/a'),...input('/b'),...after,'/out']);expect(result.exitCode,format+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),format).toEqual(native);checked++;
  }
  expect(checked).toBe(8);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native maskfun through the timed backend on the actor and timed paths in rawvideo and framecrc',async()=>{
 reference();const root=mkdtempSync(join(tmpdir(),'edge-maskfun-timed-'));let count=0;
 try{
  for(const [source,width,height]of [['gray',5,3],['yuv420p',6,4],['gbrp',5,3]] as const){
   const input=pattern(pixelLayout(source,width,height).bytes,width*31),files=new Map([['/in',input]]);writeFileSync(join(root,'input.raw'),input);
   for(const description of ['maskfun','maskfun=low=100:high=50:sum=255:planes=5,hflip','maskfun=fill=77:sum=0'])for(const format of ['rawvideo','framecrc'])for(const scheduler of ['producer','pull'] as const){
    const before=['-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-framerate','25'],after=['-vf',description,'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f',format];
    const native=execFileSync(ffmpeg,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(files,timed(scheduler),()=>sink.output).exec(['-y',...before,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}/${scheduler}`;
    expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(native);expect(sink.committed,label).toBe(true);count++;
   }
  }
  expect(count).toBe(36);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('fails like native for out-of-range maskfun options before opening any output on every path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-maskfun-reject-'));let count=0;
 try{
  const input=pattern(pixelLayout('gray',5,3).bytes,1),files=new Map([['/in',input],['/b',input]]);writeFileSync(join(root,'input.raw'),input);
  const source=(path:string)=>['-f','rawvideo','-pixel_format','gray','-video_size','5x3','-framerate','25','-i',path];
  const cases:readonly (readonly [string,readonly string[],ExecutionBackend,string])[]=[
   ['linear',['-vf','maskfun=low=65536','-f','rawvideo','OUT0'],media(),'Invalid maskfun low'],
   ['linear-chain',['-vf','hflip,maskfun=planes=16','-f','framecrc','OUT0'],media(),'Invalid maskfun planes'],
   ['graph',['-filter_complex','[0:v]split[a][b];[a]maskfun=fill=-1[l];[b]null[r]','-map','[l]','-f','rawvideo','OUT0','-map','[r]','-f','rawvideo','OUT1'],media(),'Invalid maskfun fill'],
   ['stream',['-filter_complex','[0:v]maskfun=sum=70000[a];[1:v]null[b];[a][b]hstack[out]','-map','[out]','-f','rawvideo','OUT0'],media(),'Invalid maskfun sum'],
   ['actor',['-vf','maskfun=high=65536','-c:v','rawvideo','-f','framecrc','OUT0'],timed('producer'),'Invalid maskfun high'],
   ['timed',['-vf','maskfun=high=-1','-c:v','rawvideo','-f','framecrc','OUT0'],timed('pull'),'Invalid maskfun high'],
  ];
  for(const [path,after,backend,message]of cases){
   const inputs=path==='stream'?[...source(join(root,'input.raw')),...source(join(root,'input.raw'))]:source(join(root,'input.raw'));
   const native=spawnSync(ffmpeg,['-y','-v','error',...inputs,...after.map(value=>value.startsWith('OUT')?join(root,value):value)],{timeout:10000});expect(native.status,path).not.toBe(0);
   for(const name of ['OUT0','OUT1'])expect(existsSync(join(root,name)),path).toBe(false);
   let opened=0;const result=await frontend(files,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y',...(path==='stream'?[...source('/in'),...source('/b')]:source('/in')),...after.map(value=>value.startsWith('OUT')?'/'+value:value)]);
   expect(result.exitCode,path).not.toBe(0);expect(opened,path).toBe(0);expect(JSON.stringify(result.diagnostics),path).toContain(message);count++;
  }
  expect(count).toBe(6);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 // Native converts packed RGB with alpha to gbrap, which has no frame storage here: refused by name on every path and CLI backend.
 // sum=255 keeps the noise sources below the empty-frame threshold, so the binarised samples are compared.
 const outcome=await nativeNegotiationOutcome('maskfun=low=100:high=150:sum=255',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
