import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {availableParallelism,constants,tmpdir} from 'node:os';
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
const ffmpeg=resolve('.build/reference/ffmpeg'),time={num:1n,den:25n},linux=process.platform==='linux'&&process.arch==='x64';
const sizes=[[1,1],[2,2],[5,3],[7,5],[8,6],[17,9]] as const,holdFormats=['yuv420p','yuv422p','yuv444p','yuva420p'] as const;
/** The pinned commit built without x86 assembly, read from the local build record; no binary digest is pinned. */
function provenance():void{
 expect(existsSync(ffmpeg),'npm run bootstrap -- --only npm,submodule,reference --allow-unpinned-reference').toBe(true);
 const build=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;flags:readonly string[]};
 expect(build.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(build.flags).toContain('--disable-x86asm');
}
/** Frame 0 is LCG noise. Frame 1 tiles chroma with the green (86,74) and blue (255,107) keys, near-key ramps, edges and saturated values.
 * Frame 2 is constant planes with a key-coloured top-left quarter. Luma and alpha carry ramps. */
function clip(format:string,width:number,height:number,frames=3):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let seed=0x2545f491;
 for(let f=0;f<frames;f++)for(const [p,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const chroma=p===1||p===2,tile=(Math.floor(x/2)+Math.floor(y/2)*3+f)%5,green=p===1?86:74,blue=p===1?255:107;
  const structured=!chroma?(x*37+y*11+p*50)&255:tile===0?green:tile===1?blue:tile===2?Math.max(0,Math.min(255,green+((x*5+y*3)%31)-15)):tile===3?(x+y)%2?0:255:(x^y)*29&255;
  const constant=!chroma?(p===0?120:200):x<plane.width/2&&y<plane.height/2?green:p===1?140:90;
  out[f*layout.bytes+plane.offset+y*plane.rowBytes+x]=f%3===0?seed>>>24:f%3===1?structured:constant;
 }
 return out;
}
/** Padded strides filled with a sentinel, so a kernel that reads past the row differs. */
function padded(format:string,width:number,height:number,bytes:Uint8Array,index:number,padding:number):VideoFrameData{
 const layout=pixelLayout(format,width,height),base=index*layout.bytes;
 return {width,height,pixelFormat:format,planes:layout.planes.map(p=>{const data=new Uint8Array((p.rowBytes+padding)*p.height).fill(211);for(let row=0;row<p.height;row++)data.set(bytes.subarray(base+p.offset+row*p.rowBytes,base+p.offset+(row+1)*p.rowBytes),row*(p.rowBytes+padding));return data;}),linesizes:layout.planes.map(p=>p.rowBytes+padding),pts:{value:BigInt(index),timeBase:time},metadata:{}};
}
const nativeRaw=(format:string,width:number,height:number,file:string,vf:string,extra:readonly string[]=[])=>execFileSync(ffmpeg,['-v','error','-cpuflags','0',...extra,'-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',vf,'-pix_fmt',format,'-f','rawvideo','-'],{maxBuffer:1<<24});
/** Every case through the linear and frame-graph planners with padded input strides, against native rawvideo bytes. */
function kernelCases(root:string,format:string,cases:readonly (readonly [number,number])[],filters:readonly string[]):number{
 let count=0;
 for(const [width,height]of cases){
  const input=clip(format,width,height),file=join(root,`${format}-${width}x${height}.raw`);writeFileSync(file,input);
  for(const vf of filters){
   const label=`${format}/${width}x${height}/${vf}`,native=nativeRaw(format,width,height,file,vf);
   const linear=compileVideoFilterChain(vf).plan(format,width,height,{arithmetic:'scalar'}),graph=compileVideoFilterGraph(`[0:v]${vf}[o]`).plan({format,width,height},[format],{arithmetic:'scalar'});
   const frames=[0,1,2].map(n=>padded(format,width,height,input,n,n*3)),budget={maxFrameBytes:1<<16,maxStateBytes:0};
   const viaLinear=frames.map(frame=>linear.apply(frame,budget)),viaGraph=frames.map(frame=>graph.apply(frame,{...budget,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!);
   expect(linear.stages.map(stage=>stage.operation),label).toEqual([vf.split('=')[0]]);
   expect(Buffer.concat(viaLinear.flatMap(frame=>frame.planes)),label).toEqual(native);expect(Buffer.concat(viaGraph.flatMap(frame=>frame.planes)),label).toEqual(native);
   expect(viaLinear.map(frame=>frame.pts?.value),label).toEqual([0n,1n,2n]);count++;
  }
 }
 return count;
}
const keyOptions=['','green','green:0.1','green:0.3:0.2','blue:0.05:0.2','blue:1','red:0.00001','0x00ff00:0.2:1','color=0x003050:yuv=1:similarity=0.1:blend=0.05','color=#808080:similarity=0.5','green@0.3:0.15:0.0001','blue:0.02:0.00011','yuv=true:color=0x115aff:similarity=0.08:blend=0.5'];
const holdIntegerOptions=['','green','green:0.1','blue:0.05','red:0.00001:0','0x00ff00:1','color=0x003050:yuv=1:similarity=0.1','color=#808080:similarity=0.5:blend=0.0001'];
const holdBlendOptions=['green:0.1:0.2','blue:0.05:0.5','color=0x003050:yuv=1:similarity=0.02:blend=1','red:0.00001:0.00011','green:0.2:0.05'];
it('matches native chromakey alpha across keys, similarity, blend, yuv colours, sizes and noise and structured frames',()=>{
 provenance();const root=mkdtempSync(join(tmpdir(),'edge-chromakey-'));
 try{
  let count=kernelCases(root,'yuva420p',sizes,keyOptions.map(options=>`chromakey=${options?options+':':''}threads=1`));
  // One row runs one native slice whatever the thread count, so threads=1 is not needed there.
  count+=kernelCases(root,'yuva420p',[[1,1],[2,1],[7,1],[17,1],[64,1]],keyOptions.slice(0,7).map(options=>options?`chromakey=${options}`:'chromakey'));
  expect(count).toBe(113);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native integer chromahold across formats, keys, similarity, yuv colours, odd chroma edges and noise and structured frames',()=>{
 provenance();const root=mkdtempSync(join(tmpdir(),'edge-chromahold-'));let count=0;
 try{
  for(const format of holdFormats)count+=kernelCases(root,format,sizes,holdIntegerOptions.map(options=>options?`chromahold=${options}`:'chromahold'));
  expect(count).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
// The blend ramp computes 128 + (u - 128) * f, a multiply-add that clang may fuse on macOS arm64.
it.skipIf(!linux)('matches native chromahold blend ramps on linux-x64',()=>{
 provenance();const root=mkdtempSync(join(tmpdir(),'edge-chromahold-blend-'));let count=0;
 try{
  for(const format of holdFormats)count+=kernelCases(root,format,sizes,holdBlendOptions.map(options=>`chromahold=${options}`));
  expect(count).toBe(120);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
const memory=(files:Map<string,Uint8Array>)=>{
 const published=new Map<string,Uint8Array>();let opened=0;
 const filesystem:VirtualFileSystem={async openRead(path){const bytes=files.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){opened++;const sink=collectingOutput();return {...sink.output,async commit(){await sink.output.commit();published.set(path,sink.bytes());}};}};
 return {filesystem,published,opened:()=>opened};
};
const timedStorage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const budget={maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
const backend=(scheduler?:TimedVideoScheduler)=>scheduler?createTimedVideoBackend({storage:timedStorage,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}}):createMediaBackend({pixelArithmetic:'scalar'});
it('matches native chromakey and chromahold rawvideo and framecrc CLI outputs with and without -ss/-t on the linear, graph, stream, actor and timed paths',async()=>{
 provenance();const root=mkdtempSync(join(tmpdir(),'edge-chromakey-cli-'));let count=0;
 try{
  for(const [format,filter,second]of [['yuva420p','chromakey=green:0.1:0.2:threads=1','chromakey=threads=1:color=blue:similarity=0.05'],...holdFormats.map(format=>[format,'chromahold=green:0.1','chromahold=color=0x003050:yuv=1:similarity=0.2'] as const)] as const)for(const [width,height]of [[7,5],[17,9]] as const){
   const a=clip(format,width,height,3),b=clip(format,width,height,4).subarray(pixelLayout(format,width,height).bytes),files=new Map([['/a',a],['/b',b]]);writeFileSync(join(root,'a'),a);writeFileSync(join(root,'b'),b);
   const input=(path:string)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',path];
   const cases:readonly {path:string;args:(name:(p:string)=>string)=>string[];scheduler?:TimedVideoScheduler}[]=[
    {path:'linear',args:name=>[...input(name('a')),'-vf',filter]},
    {path:'graph',args:name=>[...input(name('a')),'-filter_complex',`[0:v]${second}[x]`,'-map','[x]']},
    {path:'stream',args:name=>[...input(name('a')),...input(name('b')),'-filter_complex',`[0:v]${filter}[l];[1:v]${second}[r];[l][r]hstack[x]`,'-map','[x]']},
    {path:'actor',args:name=>[...input(name('a')),'-filter_complex',`[0:v]${filter},vflip[x]`,'-map','[x]'],scheduler:'producer'},
    {path:'timed',args:name=>[...input(name('a')),'-filter_complex',`[0:v]split[s][t];[s]${second}[x];[t]nullsink`,'-map','[x]'],scheduler:'pull'},
   ];
   for(const entry of cases)for(const muxer of ['rawvideo','framecrc'])for(const window of [[],['-ss','0.04','-t','0.08']]){
    const after=[...window,...(entry.scheduler?['-fps_mode','passthrough']:[]),'-pix_fmt',format,'-c:v','rawvideo','-bitexact','-f',muxer],label=`${format}/${width}x${height}/${entry.path}/${muxer}/${window.join(' ')}`;
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...entry.args(p=>join(root,p)),...after,'-']);
    const io=memory(files),result=await new FFmpeg({filesystem:io.filesystem,backend:backend(entry.scheduler),budget}).exec(['-y',...entry.args(p=>'/'+p),...after,'/out']);
    expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(Buffer.from(io.published.get('/out')!),label).toEqual(native);count++;
   }
  }
  expect(count).toBe(200);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native replayed chromakey and chromahold branches frame by frame through createReplayVideoExecution',async()=>{
 provenance();const root=mkdtempSync(join(tmpdir(),'edge-chromakey-stream-'));let checked=0;
 try{
  for(const [format,graphs]of [['yuva420p',['[in]chromakey=green:0.2:0.1:threads=1[out]','[in]split[x][y];[x]chromakey=blue:0.05:threads=1[l];[y]chromakey=threads=1:color=red:blend=0.3[r];[l][r]vstack[out]']],...holdFormats.map(format=>[format,['[in]chromahold=green:0.1[out]','[in]split[x][y];[x]chromahold=blue:0.05[l];[y]chromahold=color=0x003050:yuv=1[r];[l][r]hstack[out]']] as const)] as const){
   const width=9,height=7,frameBytes=pixelLayout(format,width,height).bytes,input=clip(format,width,height,3),file=join(root,'in.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<3;n++){signal.throwIfAborted();yield {...padded(format,width,height,input.subarray(n*frameBytes,(n+1)*frameBytes),0,0),pts:{value:BigInt(n),timeBase:time}};}}};}};
   for(const graph of graphs){
    const execution=createReplayVideoExecution(graph,[replay],[format],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-pix_fmt',format,'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${format}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(10);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('agrees with native at the default filter thread count and -filter_threads 1 wherever it runs, and refuses tall default-thread chromakey',async()=>{
 provenance();const root=mkdtempSync(join(tmpdir(),'edge-chromakey-threads-'));let agreed=0,differed=0,refused=0;
 try{
  const runs:[string,string,boolean][]=[...holdFormats.flatMap(format=>[...holdIntegerOptions,...holdBlendOptions].map(options=>[format,`chromahold=${options||'similarity=0.01'}`,true] as [string,string,boolean])),
   ...keyOptions.map(options=>['yuva420p',`chromakey=${options?options+':':''}threads=1`,true] as [string,string,boolean]),...keyOptions.map(options=>['yuva420p',options?`chromakey=${options}`:'chromakey',false] as [string,string,boolean])];
  for(const [width,height]of [...sizes,[64,1],[17,33]] as const)for(const [format,vf,runs1]of runs){
   const file=join(root,`${format}-${width}x${height}.raw`);if(!existsSync(file))writeFileSync(file,clip(format,width,height));
   const auto=nativeRaw(format,width,height,file,vf),single=nativeRaw(format,width,height,file,vf,['-filter_threads','1']);
   const runs=runs1||height===1;
   if(runs){expect(auto,`${format}/${width}x${height}/${vf}`).toEqual(single);agreed++;continue;}
   // Native restarts the u/v windows at the key in each slice, so default-thread output depends on the host CPU count.
   if(!auto.equals(single))differed++;
   expect(()=>compileVideoFilterChain(vf).plan(format,width,height),vf).toThrow('Chromakey frames taller than one row need threads=1');refused++;
  }
  expect([agreed,refused]).toEqual([8*(4*13+13)+2*13,6*13]);
  if(availableParallelism()>1)expect(differed).toBeGreaterThan(0);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native option acceptance and refuses invalid colors, out-of-range floats, expressions and other threads before output',async()=>{
 provenance();const root=mkdtempSync(join(tmpdir(),'edge-chromakey-options-'));let accepted=0,rejected=0,scoped=0;const statuses=new Map<string,number|null>();
 try{
  const format='yuva420p',width=7,height=5,input=clip(format,width,height,1),file=join(root,'in.raw');writeFileSync(file,input);
  const options=['threads=1','green:threads=1','GrEeN:0.5:threads=1','#00FF00@0.2:threads=1','0x00ff0080:threads=1','color=AliceBlue:threads=1','similarity=1:threads=1','similarity=0.00001:threads=1','blend=1:threads=1','blend=-0:threads=1','yuv=1:threads=1','yuv=on:threads=1','yuv=false:threads=1','similarity=.5:threads=1','similarity=5e-1:threads=1','similarity=+0.25:threads=1','threads=01',
   'nosuchcolor:threads=1','#ff00:threads=1','red@1.5:threads=1','color=:threads=1','similarity=0:threads=1','similarity=0.000009:threads=1','similarity=1.5:threads=1','blend=-0.5:threads=1','blend=2:threads=1','yuv=2:threads=1','yuv=maybe:threads=1','foo=1:threads=1',
   'similarity=1/2:threads=1','similarity=0x1:threads=1','blend=PI/4:threads=1','random:threads=1','red@nan:threads=1','threads=2','threads=0','enable=1:threads=1'];
  const scopedOptions=new Set(['similarity=1/2:threads=1','similarity=0x1:threads=1','blend=PI/4:threads=1','random:threads=1','red@nan:threads=1','threads=2','threads=0','enable=1:threads=1']);
  for(const name of ['chromakey','chromahold'])for(const text of options){
   const vf=`${name}=${text}`,native=spawnSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',vf,'-pix_fmt',format,'-f','rawvideo','-'],{timeout:10000});
   let actual:Buffer|null=null;try{actual=Buffer.from(compileVideoFilterChain(vf).plan(format,width,height,{arithmetic:'scalar'}).apply(padded(format,width,height,input,0,3),{maxFrameBytes:1<<16,maxStateBytes:0}).planes.flatMap(plane=>[...plane]));}catch(error){expect(error,vf).toBeInstanceOf(Error);}
   if(scopedOptions.has(text)){expect(actual,vf).toBeNull();scoped++;continue;}
   if(native.status!==0){
    expect(actual,vf).toBeNull();statuses.set(text,native.status);rejected++;
    // The same refusal through the CLI, before any output is opened.
    const io=memory(new Map([['/a',input]])),result=await new FFmpeg({filesystem:io.filesystem,backend:backend(),budget}).exec(['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-i','/a','-vf',vf,'-f','rawvideo','/out']);
    // Every scoped filter parse refusal exits 1 here: the backends carry no native status for filter errors (see docs/contributing/chromakey.md).
    expect(result.exitCode,vf).toBe(1);expect(io.opened(),vf).toBe(0);continue;
   }
   expect(actual,vf).toEqual(native.stdout);accepted++;
  }
  // Invalid colors and booleans fail natively with EINVAL, out-of-range floats with ERANGE (host errno values), unknown keys with
  // AVERROR_OPTION_NOT_FOUND, whose exit status 8 is no errno.
  const einval=256-constants.errno.EINVAL,erange=256-constants.errno.ERANGE;
  expect(Object.fromEntries(statuses)).toEqual({'nosuchcolor:threads=1':einval,'#ff00:threads=1':einval,'red@1.5:threads=1':einval,'color=:threads=1':einval,'similarity=0:threads=1':erange,'similarity=0.000009:threads=1':erange,'similarity=1.5:threads=1':erange,'blend=-0.5:threads=1':erange,'blend=2:threads=1':erange,'yuv=2:threads=1':einval,'yuv=maybe:threads=1':einval,'foo=1:threads=1':8});
  expect([accepted,rejected,scoped]).toEqual([34,24,16]);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses tall default-thread chromakey and the yuva444p pick of packed alpha sources on every CLI backend before output',async()=>{
 provenance();let count=0;
 for(const [format,vf,message]of [['yuva420p','chromakey=green','Chromakey frames taller than one row need threads=1'],['rgba','chromakey=threads=1','negotiates yuva444p, which is not implemented']] as const){
  const width=5,height=3,input=new Uint8Array(pixelLayout(format,width,height).bytes*2).fill(100);
  for(const [scheduler,args]of [[undefined,['-vf',vf]],[undefined,['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']],['producer',['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']],['pull',['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']]] as const){
   const io=memory(new Map([['/a',input]])),result=await new FFmpeg({filesystem:io.filesystem,backend:backend(scheduler),budget}).exec(['-y','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-i','/a',...args,'-c:v','rawvideo','-f','rawvideo','/out']);
   expect(result.exitCode,`${vf}/${args[0]}/${scheduler}`).not.toBe(0);expect(io.opened()).toBe(0);expect(result.diagnostics.at(-1)?.message,`${vf}/${args[0]}/${scheduler}`).toContain(message);count++;
  }
 }
 expect(count).toBe(8);
},120000);
it('negotiates every accepted source as native does and refuses picks without storage before output on every path',async({signal})=>{
 // Native picks a yuva format for chromakey from every source; only yuva420p has frame storage here. chromahold keeps planar YUV,
 // converts RGB, gbrp and gray to yuv444p and packed RGB with alpha to yuva444p, which is refused by name.
 provenance();
 const key=await nativeNegotiationOutcome('chromakey=green:0.1:0.2:threads=1',negotiationSources,signal),hold=await nativeNegotiationOutcome('chromahold=green:0.1',negotiationSources,signal);
 expect(key.matched).toEqual({yuv420p:'yuva420p',nv12:'yuva420p',nv21:'yuva420p',yuva420p:'yuva420p',yuvj420p:'yuva420p'});
 expect(key.refused).toEqual({rgb24:'yuva444p',bgr24:'yuva444p',yuv422p:'yuva422p',yuv444p:'yuva444p',gray:'yuva444p',argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p',gbrp:'yuva444p',yuvj422p:'yuva422p',yuvj444p:'yuva444p'});
 expect(hold.matched).toEqual({yuv420p:'yuv420p',rgb24:'yuv444p',bgr24:'yuv444p',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'yuv444p',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'yuv444p',yuvj420p:'yuv420p',yuvj422p:'yuv422p',yuvj444p:'yuv444p'});
 expect(hold.refused).toEqual({argb:'yuva444p',rgba:'yuva444p',abgr:'yuva444p',bgra:'yuva444p'});
 expect([key.checks,hold.checks]).toEqual([113,89]);
},300000);
