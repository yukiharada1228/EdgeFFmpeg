import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions,TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),time={num:1n,den:25n};
/** The sandbox-built reference: its commit and configuration, never a pinned binary digest. */
const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
it('runs against a reference built from commit 946fcce0 with --disable-x86asm',()=>{expect(metadata.commit.startsWith('946fcce0')).toBe(true);expect(metadata.flags).toContain('--disable-x86asm');});
/** The executable members of the native list. */
const formats=['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','argb','rgba','abgr','bgra','yuva420p','gbrp'] as const;
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const;
/** Frame 0 is LCG noise; frame 1 horizontal and vertical ramps with saturated edges; frame 2 constant planes with a noisy right half. */
function clip(format:string,width:number,height:number,frames=3,seed=0x9e3779b9):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);
 for(let f=0;f<frames;f++)for(const [p,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.rowBytes;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const kind=f%3,edge=x===0||y===0||x===plane.rowBytes-1||y===plane.height-1;
  out[f*layout.bytes+plane.offset+y*plane.rowBytes+x]=kind===0?seed>>>24:kind===1?(edge?(x+y)%2*255:(x*37+y*11+p*53)&255):x*2<plane.rowBytes?17+p*61:seed>>>24;
 }
 return out;
}
/** Padded positive strides filled with a sentinel. */
function padded(format:string,width:number,height:number,bytes:Uint8Array,index:number,padding:number):VideoFrameData{
 const layout=pixelLayout(format,width,height),base=index*layout.bytes;
 return {width,height,pixelFormat:format,planes:layout.planes.map(p=>{const data=new Uint8Array((p.rowBytes+padding)*p.height).fill(211);for(let row=0;row<p.height;row++)data.set(bytes.subarray(base+p.offset+row*p.rowBytes,base+p.offset+(row+1)*p.rowBytes),row*(p.rowBytes+padding));return data;}),linesizes:layout.planes.map(p=>p.rowBytes+padding),pts:{value:BigInt(index),timeBase:time},metadata:{}};
}
/** Defaults, explicit rectangles, overlaps (same rows, same columns, diagonal), edges and clamping, odd sizes with chroma rounding,
 * zero and negative sizes, comparisons and a, and fractional values truncated toward zero. */
const frameCases=['swaprect','swaprect=1:1:0:0:1:0','swaprect=2:2:0:0:1:1','swaprect=w=3:h=1:x1=0:y1=0:x2=2:y2=0','swaprect=w=1:h=3:x1=0:y1=0:x2=0:y2=1','swaprect=w/2+1:h/2+1:w/3:h/3:0:0',
 'swaprect=w=w:h=h:x1=0:y1=0:x2=0:y2=0','swaprect=3:3:w-2:h-2:0:0','swaprect=w=5:h=5:x1=-4:y1=-9:x2=w+3:y2=h*2','swaprect=w=3:h=3:x1=1:y1=1:x2=2:y2=0','swaprect=w=0:h=2','swaprect=w=-3:h=0',
 'swaprect=w=2:h=-1:x1=1','swaprect=w=lt(w\\,6)+2:h=gte(h\\,5)*3+1:x1=a*2:y1=a*a:x2=a/2:y2=0','swaprect=w=1.9:h=2.99:x1=-0.5:y1=1.5:x2=w/2.5:y2=h/3.5'] as const;
it('matches native swaprect on every executable format and size, frame by frame on the linear and graph planners',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-swaprect-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const input=clip(format,width,height),file=join(root,'in.raw');writeFileSync(file,input);
   for(const description of frameCases){
    const label=`${format}/${width}x${height}/${description}`,native=execFileSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25','-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-']);
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[format],{arithmetic:'scalar'});
    const frames=[0,1,2].map(n=>padded(format,width,height,input,n,n*3)),budget={maxFrameBytes:1<<16,maxStateBytes:0};
    const viaLinear=frames.map(frame=>linear.apply(frame,budget)),viaGraph=frames.map(frame=>graph.apply(frame,{...budget,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!);
    expect(linear.stages.map(stage=>stage.operation)).toEqual(['swaprect']);
    expect(Buffer.concat(viaLinear.flatMap(frame=>frame.planes)),label).toEqual(native);expect(Buffer.concat(viaGraph.flatMap(frame=>frame.planes)),label).toEqual(native);
    expect(viaLinear.map(frame=>frame.pts?.value)).toEqual([0n,1n,2n]);count++;
   }
  }
  expect(count).toBe(formats.length*sizes.length*frameCases.length);
 }finally{rmSync(root,{recursive:true,force:true});}
},900000);
const memory=(files:Map<string,Uint8Array>)=>{
 const published=new Map<string,Uint8Array>();
 const filesystem:VirtualFileSystem={async openRead(path){const bytes=files.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){const sink=collectingOutput();return {...sink.output,async commit(){await sink.output.commit();published.set(path,sink.bytes());}};}};
 return {filesystem,published};
};
const timedStorage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const budget={maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
type PathCase={readonly path:string;readonly args:(name:(p:string)=>string)=>string[];readonly scheduler?:TimedVideoScheduler};
async function cliMatches(root:string,format:string,width:number,height:number,cases:readonly PathCase[],times:readonly (readonly [readonly string[],readonly string[]])[]):Promise<number>{
 const a=clip(format,width,height,3),b=clip(format,width,height,4,7).subarray(pixelLayout(format,width,height).bytes),files=new Map([['/a',a],['/b',b]]);writeFileSync(join(root,'a'),a);writeFileSync(join(root,'b'),b);let count=0;
 for(const entry of cases)for(const muxer of ['rawvideo','framecrc'])for(const [inputTime,outputTime]of times){
  const before=(path:string)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25',...inputTime,'-i',path];
  const args=(name:(p:string)=>string)=>entry.args(name).flatMap(arg=>arg.startsWith('@')?before(name(arg.slice(1))):[arg]);
  const after=[...(entry.scheduler?['-fps_mode','passthrough']:[]),...outputTime,'-pix_fmt',format,'-c:v','rawvideo','-bitexact','-f',muxer],label=`${format}/${width}x${height}/${entry.path}/${muxer}/${inputTime.join(' ')}/${outputTime.join(' ')}`;
  const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...args(p=>join(root,p)),...after,'-']);
  const io=memory(files),backend=entry.scheduler?createTimedVideoBackend({storage:timedStorage,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler:entry.scheduler}}):createMediaBackend({pixelArithmetic:'scalar'});
  const result=await new FFmpeg({filesystem:io.filesystem,backend,budget}).exec(['-y',...args(p=>'/'+p),...after,'/out']);
  expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(Buffer.from(io.published.get('/out')!),label).toEqual(native);count++;
 }
 return count;
}
const pathCases:readonly PathCase[]=[
 {path:'linear',args:()=>['@a','-vf','swaprect=w=3:h=2:x1=a*2:y1=1:x2=w-3:y2=0']},
 {path:'graph',args:()=>['@a','-filter_complex','[0:v]swaprect=2:3:x1=w-2:y1=1:x2=0:y2=h/3[x]','-map','[x]']},
 {path:'stream',args:()=>['@a','@b','-filter_complex','[0:v]swaprect[l];[1:v]swaprect=w=w/2+1:h=2:x1=0:y1=h/2:x2=w/3:y2=h-2[r];[l][r]hstack[x]','-map','[x]']},
 {path:'actor',args:()=>['@a','-filter_complex','[0:v]swaprect=w=3:h=3:x1=t*50:y1=0:x2=1:y2=h-3[x]','-map','[x]'],scheduler:'producer'},
 {path:'timed',args:()=>['@a','-filter_complex','[0:v]split[s][t];[s]swaprect=4:2:x1=1:y1=t*25+1:x2=w-4:y2=0[x];[t]nullsink','-map','[x]'],scheduler:'pull'},
];
const cliTimes=[[[],[]],[['-ss','0.04'],['-t','0.05']],[[],['-ss','0.04','-frames:v','1']]] as const;
it('matches native swaprect rawvideo and framecrc CLI outputs on the linear, graph, stream, actor and timed paths, with and without -ss and -t',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-swaprect-cli-'));let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[7,5],[8,6]] as const)count+=await cliMatches(root,format,width,height,pathCases,cliTimes);
  expect(count).toBe(formats.length*2*pathCases.length*2*cliTimes.length);
 }finally{rmSync(root,{recursive:true,force:true});}
},900000);
/** t-dependent rectangles (the frame pts in its time base) on the paths that hand native filter timestamps to the operator. */
const timedCases:readonly PathCase[]=[
 {path:'actor',args:()=>['@a','-filter_complex','[0:v]swaprect=w=2+t*25:h=t*50+1:x1=t*25*3:y1=lt(t\\,0.05):x2=w-3:y2=h-t*25-1[x]','-map','[x]'],scheduler:'producer'},
 {path:'actor',args:()=>['@a','-filter_complex','[0:v]swaprect=w=w/2:h=h/2:x1=w/2-t*25:y1=h/2:x2=t*25:y2=0[x]','-map','[x]'],scheduler:'activation'},
 {path:'timed',args:()=>['@a','-filter_complex','[0:v]swaprect=w=3:h=2:x1=w-t*75:y1=gte(t\\,0.04)*2:x2=0:y2=h-2[x]','-map','[x]'],scheduler:'pull'},
];
it('matches native t-dependent swaprect expressions on the actor and timed paths at every size, with and without -ss and -t',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-swaprect-time-'));let count=0;
 try{
  for(const format of ['yuv420p','nv21','bgr24','yuva420p','gbrp','yuv422p'])for(const [width,height]of sizes)count+=await cliMatches(root,format,width,height,timedCases,cliTimes);
  expect(count).toBe(6*sizes.length*timedCases.length*2*cliTimes.length);
 }finally{rmSync(root,{recursive:true,force:true});}
},900000);
it('matches native replayed swaprect branches frame by frame through createReplayVideoExecution',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-swaprect-stream-'));let checked=0;
 try{
  for(const format of formats){
   const width=7,height=5,frameBytes=pixelLayout(format,width,height).bytes,input=clip(format,width,height,3),file=join(root,'in.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<3;n++){signal.throwIfAborted();yield {...padded(format,width,height,input.subarray(n*frameBytes,(n+1)*frameBytes),0,0),pts:{value:BigInt(n),timeBase:time}};}}};}};
   for(const graph of ['[in]swaprect=w=3:h=2:x1=w-4:y1=0:x2=w-3:y2=h-2[out]','[in]split[x][y];[x]swaprect[l];[y]swaprect=2:2:1:1:2:2[r];[l][r]vstack[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[format],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-pix_fmt',format,'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${format}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(28);
 }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches native option acceptance and outputs, refusing n, t on scoped paths, sar, dar, unported functions, timelines and native faults explicitly',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-swaprect-options-'));let accepted=0,rejected=0,faulted=0,scoped=0;
 try{
  const format='yuv420p',width=9,height=7,input=clip(format,width,height,1),file=join(root,'in.raw');writeFileSync(file,input);
  const cases=['','4','4:3','4:3:1:2:5:4','w=2:h=2:x1=0:y1=0:x2=7:y2=5','w=w:h=h','x1=1e9:y1=-1e9','w=1e9:h=1e9','w=0x3:h=2','w=2k/1000:h=2','w=max(2\\,3):h=min(4\\,1)','w=if(gt(w\\,8)\\,3\\,1):h=2','w=trunc(w/2.5):h=floor(h/3)','w=abs(-3):h=sqrt(9)','w=st(0\\,2)*ld(0):h=2','w=3:h=2:x1=PI:y1=E',
   'w=','w=foo','w=1+','w=(2','x1=2:x1=3','h=2:w=3:2','foo=1','enable=1','threads=1',
   'w=n+1','x1=t*25','w=sin(1)+2','w=2^2','w=exp(1)','x1=time(0)','w=sar*2','w=dar','w=nan','w=1/0','w=3e9','w=-3:h=2','w=-1:h=1:x1=0'];
  for(const options of cases){
   const description=options?`swaprect=${options}`:'swaprect',native=spawnSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-framerate','25','-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-'],{timeout:10000});
   let actual:Buffer|null=null;try{actual=Buffer.from(compileVideoFilterChain(description).plan(format,width,height,{arithmetic:'scalar'}).apply(padded(format,width,height,input,0,3),{maxFrameBytes:1<<16,maxStateBytes:0}).planes.flatMap(plane=>[...plane]));}catch(error){expect(error,description).toBeInstanceOf(Error);}
   if(native.status===null){expect(native.signal,description).toMatch(/^SIG(?:SEGV|BUS|ABRT)$/);expect(actual,description).toBeNull();faulted++;}else if(native.status!==0){expect(actual,description).toBeNull();rejected++;}else if(actual===null)scoped++;else{expect(actual,description).toEqual(native.stdout);accepted++;}
  }
  // Native faults (a signal, no exit status) on infinite, out-of-int and negative widths with positive heights; each is refused here.
  expect([accepted,rejected,faulted,scoped]).toEqual([17,7,4,10]);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses t on the scoped CLI paths and time-independent native faults on every path before any output is committed',async()=>{
 const format='gray',width=8,height=6,a=clip(format,width,height,3);let count=0;
 for(const [args,message]of [[['-vf','swaprect=x1=t*25'],'actor and timed paths only'],[['-filter_complex','[0:v]swaprect=y2=t[x]','-map','[x]'],'actor and timed paths only'],[['-vf','swaprect=w=-1:h=1'],'negative widths'],[['-filter_complex','[0:v]swaprect=w=1/0[x]','-map','[x]'],'outside int']] as const)for(const scheduler of [undefined,'producer','pull'] as const){
  if(scheduler&&message==='actor and timed paths only')continue;
  const io=memory(new Map([['/a',a]])),backend=scheduler?createTimedVideoBackend({storage:timedStorage,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}}):createMediaBackend({pixelArithmetic:'scalar'});
  const result=await new FFmpeg({filesystem:io.filesystem,backend,budget}).exec(['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i','/a',...args,'-f','rawvideo','/out']);
  expect(result.exitCode,args.join(' ')).not.toBe(0);expect(JSON.stringify(result.diagnostics)).toContain(message);expect(io.published.size).toBe(0);count++;
 }
 expect(count).toBe(8);
},120000);
it('negotiates every accepted source as native does on every path',async({signal})=>{
 // The native list holds every non-palette, non-bitstream format, so each source keeps its own format (legacy yuvj sources on linear chains).
 const outcome=await nativeNegotiationOutcome('swaprect=3:2:1:1:4:3',negotiationSources,signal);
 expect(outcome.refused).toEqual({});
 expect(outcome.matched).toEqual(Object.fromEntries(negotiationSources.map(source=>[source,source])));
 expect(outcome.checks).toBe(73);
},300000);
