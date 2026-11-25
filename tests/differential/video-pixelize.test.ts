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
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {collectingOutput} from '../helpers/output.js';
import {nativeNegotiationOutcome,negotiationSources} from '../helpers/video-negotiation-cases.js';
const ffmpeg=resolve('.build/reference/ffmpeg'),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'] as const,time={num:1n,den:25n};
/** Frame 0 is LCG noise; frame 1 is a structured pattern of 5x3 tiles with gradients and saturated values. */
function clip(format:string,width:number,height:number,frames=2):Uint8Array{
 const layout=pixelLayout(format,width,height),out=new Uint8Array(layout.bytes*frames);let seed=0x9e3779b9;
 for(let f=0;f<frames;f++)for(const [p,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++)for(let x=0;x<plane.width;x++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const tile=(Math.floor(x/5)+Math.floor(y/3)+p)%4;
  out[f*layout.bytes+plane.offset+y*plane.rowBytes+x]=f%2===0?seed>>>24:tile===0?255:tile===1?0:tile===2?(x*29+y*7+p*41)&255:(x^y)*17&255;
 }
 return out;
}
/** Padded positive strides filled with a sentinel, so a kernel that reads past the row differs. */
function padded(format:string,width:number,height:number,bytes:Uint8Array,index:number,padding:number):VideoFrameData{
 const layout=pixelLayout(format,width,height),base=index*layout.bytes;
 return {width,height,pixelFormat:format,planes:layout.planes.map(p=>{const data=new Uint8Array((p.rowBytes+padding)*p.height).fill(211);for(let row=0;row<p.height;row++)data.set(bytes.subarray(base+p.offset+row*p.rowBytes,base+p.offset+(row+1)*p.rowBytes),row*(p.rowBytes+padding));return data;}),linesizes:layout.planes.map(p=>p.rowBytes+padding),pts:{value:BigInt(index),timeBase:time},metadata:{}};
}
it('matches native pixelize across formats, modes, block sizes, plane masks and odd sizes on the linear and graph planners',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-pixelize-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[9,7],[33,17]] as const){
   const input=clip(format,width,height),file=join(root,'in.raw');writeFileSync(file,input);
   for(const mode of ['avg','min','max'])for(const block of ['w=1:h=1','2:2','3:2','width=4:height=3','','40:40'])for(const planes of ['15','1','0x6','8+1','-1']){
    const description=`pixelize=${block?block+':':''}mode=${mode}:planes=${planes}`.replace('pixelize=:','pixelize='),label=`${format}/${width}x${height}/${description}`;
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-']);
    const linear=compileVideoFilterChain(description).plan(format,width,height,{arithmetic}),graph=compileVideoFilterGraph(`[0:v]${description}[o]`).plan({format,width,height},[format],{arithmetic});
    const frames=[0,1].map(n=>padded(format,width,height,input,n,n*5)),budget={maxFrameBytes:1<<16,maxStateBytes:0};
    const viaLinear=frames.map(frame=>linear.apply(frame,budget)),viaGraph=frames.map(frame=>graph.apply(frame,{...budget,maxStateBytes:1<<20,maxResidentBytes:1<<22})[0]!);
    expect(linear.stages.map(stage=>stage.operation)).toEqual(['pixelize']);
    expect(Buffer.concat(viaLinear.flatMap(frame=>frame.planes)),label).toEqual(native);expect(Buffer.concat(viaGraph.flatMap(frame=>frame.planes)),label).toEqual(native);
    expect(viaLinear.map(frame=>frame.pts?.value)).toEqual([0n,1n]);expect(frames[0]!.planes[0]![0]).toBe(input[0]);count++;
   }
  }
  expect(count).toBe(1080);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
const memory=(files:Map<string,Uint8Array>)=>{
 const published=new Map<string,Uint8Array>();
 const filesystem:VirtualFileSystem={async openRead(path){const bytes=files.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){const sink=collectingOutput();return {...sink.output,async commit(){await sink.output.commit();published.set(path,sink.bytes());}};}};
 return {filesystem,published};
};
const timedStorage:TimedVideoBackendOptions['storage']=()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const budget={maxResidentBytes:32*1024*1024,maxBufferBytes:65536,maxPendingPackets:32,maxCpuTimeMs:20000};
it('matches native pixelize rawvideo and framecrc CLI outputs on the linear, graph, stream, actor and timed paths',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-pixelize-cli-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const format of formats)for(const [width,height]of [[9,7],[33,17]] as const){
   const a=clip(format,width,height,3),b=clip(format,width,height,4).subarray(pixelLayout(format,width,height).bytes),files=new Map([['/a',a],['/b',b]]);writeFileSync(join(root,'a'),a);writeFileSync(join(root,'b'),b);
   const input=(path:string)=>['-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','25','-i',path];
   const cases:readonly {path:string;args:(name:(p:string)=>string)=>string[];scheduler?:TimedVideoScheduler}[]=[
    {path:'linear',args:name=>[...input(name('a')),'-vf','pixelize=3:2:max']},
    {path:'graph',args:name=>[...input(name('a')),'-filter_complex','[0:v]pixelize=w=4:h=3:m=min:p=0x5[x]','-map','[x]']},
    {path:'stream',args:name=>[...input(name('a')),...input(name('b')),'-filter_complex','[0:v]pixelize=2:5[l];[1:v]pixelize=7:1:avg:planes=6[r];[l][r]hstack[x]','-map','[x]']},
    {path:'actor',args:name=>[...input(name('a')),'-filter_complex','[0:v]pixelize=5:3:min[x]','-map','[x]'],scheduler:'producer'},
    {path:'timed',args:name=>[...input(name('a')),'-filter_complex','[0:v]split[s][t];[s]pixelize=40:2:max:planes=9[x];[t]nullsink','-map','[x]'],scheduler:'pull'},
   ];
   for(const entry of cases)for(const muxer of ['rawvideo','framecrc']){
    const after=[...(entry.scheduler?['-fps_mode','passthrough']:[]),'-pix_fmt',format,'-c:v','rawvideo','-bitexact','-f',muxer],label=`${format}/${width}x${height}/${entry.path}/${muxer}`;
    const native=execFileSync(ffmpeg,['-v','error','-cpuflags','0',...entry.args(p=>join(root,p)),...after,'-']);
    const io=memory(files),backend=entry.scheduler?createTimedVideoBackend({storage:timedStorage,limits:{numericProfile:'linux-x64',maxEvents:256,scheduler:entry.scheduler}}):createMediaBackend({pixelArithmetic:arithmetic});
    const result=await new FFmpeg({filesystem:io.filesystem,backend,budget}).exec(['-y',...entry.args(p=>'/'+p),...after,'/out']);
    expect(result.exitCode,JSON.stringify({label,diagnostics:result.diagnostics})).toBe(0);expect(Buffer.from(io.published.get('/out')!),label).toEqual(native);count++;
   }
  }
  expect(count).toBe(120);
 }finally{rmSync(root,{recursive:true,force:true});}
},600000);
it('matches native replayed pixelize branches frame by frame through createReplayVideoExecution',async()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-pixelize-stream-'));let checked=0;
 try{
  for(const format of formats){
   const width=9,height=7,frameBytes=pixelLayout(format,width,height).bytes,input=clip(format,width,height,3),file=join(root,'in.raw');writeFileSync(file,input);
   const replay:ReplayVideoSource={geometry:{format,width,height},timeBase:time,open(signal){return {async *[Symbol.asyncIterator](){for(let n=0;n<3;n++){signal.throwIfAborted();yield {...padded(format,width,height,input.subarray(n*frameBytes,(n+1)*frameBytes),0,0),pts:{value:BigInt(n),timeBase:time}};}}};}};
   for(const graph of ['[in]pixelize=3:2:max[out]','[in]split[x][y];[x]pixelize=4:3:avg:planes=1[l];[y]pixelize=1:1:min[r];[l][r]vstack[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[format],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic}),chunks:Uint8Array[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(...frame.planes);stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(ffmpeg,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]','-pix_fmt',format,'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${format}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n]);checked++;
   }
  }
  expect(checked).toBe(12);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native option acceptance and outputs for integer, hex, folded and out-of-range values, refusing expressions explicitly',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-pixelize-options-')),arithmetic=referencePixelArithmetic();let accepted=0,rejected=0,scoped=0;
 try{
  const format='yuva420p',width=33,height=17,input=clip(format,width,height,1),file=join(root,'in.raw');writeFileSync(file,input);
  for(const options of ['','5','5:3','5:3:2','5:3:min:9','w=1024:h=1','width=0x3:height=0X5','mode=2','m=1:p=-1','planes=255','planes=4294967295','planes=0','planes=+8','planes=1+2-1','p=0x6:p=-2','w=0','w=1025','h=0','height=1025','mode=3','mode=-1','planes=4294967296','w=2*3','w=max','planes=all','planes=default','mode=1+1','h=4.5']){
   const description=options?`pixelize=${options}`:'pixelize',native=spawnSync(ffmpeg,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',description,'-pix_fmt',format,'-f','rawvideo','-'],{timeout:10000});
   let actual:Buffer|null=null;try{actual=Buffer.from(compileVideoFilterChain(description).plan(format,width,height,{arithmetic}).apply(padded(format,width,height,input,0,3),{maxFrameBytes:1<<16,maxStateBytes:0}).planes.flatMap(plane=>[...plane]));}catch(error){expect(error,description).toBeInstanceOf(Error);}
   if(native.status!==0){expect(actual,description).toBeNull();rejected++;}else if(actual===null)scoped++;else{expect(actual,description).toEqual(native.stdout);accepted++;}
  }
  expect([accepted,rejected,scoped]).toEqual([15,7,6]);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path',async({signal})=>{
 // Native converts packed RGB with alpha to gbrap, which has no frame storage here: refused by name on every path and CLI backend.
 // Every other source runs byte-exact on every path (legacy yuvj sources on linear chains).
 const outcome=await nativeNegotiationOutcome('pixelize=3:2',negotiationSources,signal);
 expect(outcome.refused).toEqual({argb:'gbrap',rgba:'gbrap',abgr:'gbrap',bgra:'gbrap'});
 expect(outcome.matched).toEqual({yuv420p:'yuv420p',rgb24:'gbrp',bgr24:'gbrp',yuv422p:'yuv422p',yuv444p:'yuv444p',gray:'gray',nv12:'yuv420p',nv21:'yuv420p',yuva420p:'yuva420p',gbrp:'gbrp',yuvj420p:'yuvj420p',yuvj422p:'yuvj422p',yuvj444p:'yuvj444p'});
 expect(outcome.checks).toBe(89);
},120000);
