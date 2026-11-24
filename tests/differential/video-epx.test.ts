import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {ReplayVideoSource,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {epxVideoFrame,parseEpxOptions,VideoEpxError} from '../../packages/avfilter/src/video-epx.js';
import {collectingOutput} from '../helpers/output.js';
const native=resolve('.build/reference/ffmpeg'),formats=['rgba','bgra','argb','abgr'] as const,sizes=[[1,1],[3,3],[5,4],[13,9]] as const;
// Palette words differ in single bytes, including alpha-only differences, so every byte of the 32-bit compare matters.
const palette=[[10,20,30,255],[10,20,30,0],[200,20,30,255],[10,21,30,255],[0,0,0,0]] as const;
/** Structured frames (few-colour blocks, diagonals, 1-pixel features, checkerboards, staircases, few-colour noise) plus byte noise. */
function patterns(width:number,height:number):Uint8Array[]{
 let seed=1013;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
 const pick:((x:number,y:number)=>number)[]=[
  (x,y)=>((x>>1)+(y>>1)*3)%3,(x,y)=>(x-y+64)%4===0?2:0,(x,y)=>(x+y)%3===0?3:1,(x,y)=>x===width>>1&&y===height>>1?2:x===0&&y===height-1?1:0,
  (x,y)=>(x+y)&1?4:2,(x,y)=>((x>>1)+(y>>1))&1,(x,y)=>x<y?0:x===y?2:3,()=>next()%3,()=>next()%2?1:0];
 const frames=pick.map(color=>{const data=new Uint8Array(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(palette[color(x,y)]!,(y*width+x)*4);return data;});
 frames.push(Uint8Array.from({length:width*height*4},next));return frames;
}
const decode=(data:Uint8Array,pixelFormat:string,width:number,height:number,pts:bigint)=>decodeRawVideo({streamIndex:0,data,pts,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat,width,height},{maxFrameBytes:1<<20});
const concat=(chunks:readonly Uint8Array[])=>Buffer.concat(chunks.map(chunk=>Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength)));
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return concat(layout.planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));};
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:(path:string)=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(path){return open(path);}},backend,budget:{maxResidentBytes:8*1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const timedBackend=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:()=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,structuredClone(value));},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return structuredClone(value);},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};},limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
it('matches native epx2 and epx3 pixels across packed RGBA formats, sizes and structured patterns',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-epx-kernel-'));let frames=0,changed=0;
 try{
  for(const format of formats)for(const [width,height]of sizes){
   const inputs=patterns(width,height);writeFileSync(join(root,'input.raw'),concat(inputs));
   for(const n of [2,3] as const){
    const expected=execFileSync(native,['-v','error','-threads','1','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',`epx=n=${n}`,'-f','rawvideo','-']),bytes=width*height*4*n*n;
    expect(expected.length).toBe(bytes*inputs.length);
    for(const [index,data]of inputs.entries()){
     const label=`${format}/${width}x${height}/n=${n}/${index}`,frame=decode(data,format,width,height,BigInt(index)),output=epxVideoFrame(frame,parseEpxOptions(`n=${n}`),{maxFrameBytes:bytes});
     expect([output.width,output.height,output.pixelFormat,output.linesizes[0]],label).toEqual([width*n,height*n,format,width*n*4]);
     const actual=concat(output.planes);expect(actual,label).toEqual(expected.subarray(index*bytes,(index+1)*bytes));expect(output.pts).toEqual(frame.pts);
     // Count frames where epx differs from nearest-neighbour replication, so the rules are exercised and not just replication.
     const replicated=Buffer.alloc(bytes);for(let y=0;y<height*n;y++)for(let x=0;x<width*n;x++)replicated.set(data.subarray(((y/n|0)*width+(x/n|0))*4,((y/n|0)*width+(x/n|0))*4+4),(y*width*n+x)*4);
     if(!actual.equals(replicated))changed++;frames++;
    }
   }
  }
  expect(frames).toBe(4*4*2*10);expect(changed).toBe(192);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native linear and graph epx plans with scalar conversions around the packed RGBA stage',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-epx-plan-'));let count=0;
 try{
  for(const source of ['rgba','abgr','rgb24','gray','yuv420p'])for(const [width,height]of [[5,4],[6,3]] as const){
   const base=patterns(width,height),input=source==='rgba'||source==='abgr'?base[7]!:Uint8Array.from({length:pixelLayout(source,width,height).bytes},(_,i)=>[16,16,200,90][((i>>1)+(i/width|0))%4]!);writeFileSync(join(root,'input.raw'),input);
   const frame=decode(input,source,width,height,9007199254740993n);
   for(const description of ['epx','epx=n=2','epx=2,hflip','format=bgra,epx,vflip','transpose=clock,epx=n=2,format=argb'])for(const target of [null,'rgba','yuv444p','gray']){
    const label=`${source}/${width}x${height}/${description}/${target}`,expected=execFileSync(native,['-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    const plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),arithmetic:'scalar'}),linear=plan.apply(frame,{maxFrameBytes:1<<20,maxStateBytes:plan.stateBytes});
    expect(tight(linear),label).toEqual(expected);expect(linear.pts).toEqual(frame.pts);
    const graph=compileVideoFilterGraph(`[0:v]${description}[out]`).plan({format:source,width,height},[target],{arithmetic:'scalar'}).apply(frame,{maxFrameBytes:1<<20,maxStateBytes:1<<22,maxResidentBytes:1<<24})[0]!;
    expect(tight(graph),label).toEqual(expected);count++;
   }
  }
  expect(count).toBe(200);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('matches native replayed epx streams with branches and joins frame by frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-epx-stream-'));let checked=0;
 try{
  for(const [source,target]of [['rgba',null],['bgra','rgba'],['argb','yuv444p'],['abgr','bgra']] as const){
   const inputs=patterns(5,4).slice(5),file=join(root,'input.raw');writeFileSync(file,concat(inputs));
   const replay:ReplayVideoSource={geometry:{format:source,width:5,height:4},timeBase:{num:1n,den:25n},open(signal){return {async *[Symbol.asyncIterator](){for(const [index,data]of inputs.entries()){signal.throwIfAborted();yield decode(data,source,5,4,BigInt(index));}}};}};
   for(const graph of ['[in]epx[out]','[in]epx=n=2,hflip[out]','[in]split[x][y];[x]epx=2[l];[y]epx=2,vflip[r];[l][r]hstack[out]','[in]split[x][y];[x]transpose=clock,epx[l];[y]nullsink;[l]null[out]']){
    const execution=createReplayVideoExecution(graph,[replay],[target],{maxFrameBytes:1<<16,maxStateBytes:1<<20,maxResidentBytes:1<<22,maxSourceTraversals:4},{arithmetic:'scalar'}),chunks:Buffer[]=[],stamps:bigint[]=[];
    try{for await(const frame of execution.outputs[0]!.frames){chunks.push(tight(frame));stamps.push(frame.pts!.value);}}finally{await execution.close();}
    execFileSync(native,['-y','-v','error','-cpuflags','0','-f','rawvideo','-pixel_format',source,'-s','5x4','-i',file,'-filter_complex',graph.replace('[in]','[0:v]'),'-map','[out]',...(target?['-pix_fmt',target]:[]),'-f','rawvideo',join(root,'native.raw')]);
    expect(Buffer.concat(chunks),`${source}/${target}/${graph}`).toEqual(readFileSync(join(root,'native.raw')));expect(stamps).toEqual([0n,1n,2n,3n,4n]);checked++;
   }
  }
  expect(checked).toBe(16);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches native epx CLI rawvideo and framecrc on the linear, graph, actor and timed paths',async()=>{
 const backends:readonly [string,(()=>ExecutionBackend),boolean][]=[['media',()=>createMediaBackend({pixelArithmetic:'scalar'}),true],['actor',()=>timedBackend('producer'),false],['activation',()=>timedBackend('activation'),false],['timed',()=>timedBackend('pull'),false]];let count=0;
 const root=mkdtempSync(join(tmpdir(),'edge-epx-cli-'));
 try{
  for(const source of formats){
   const input=concat(patterns(3,2).slice(0,4));writeFileSync(join(root,'input.raw'),input);
   for(const description of ['epx','epx=n=2','epx=2,hflip','split[a][b];[a]epx=2[l];[b]epx=2,vflip[r];[l][r]vstack'])for(const format of ['rawvideo','framecrc'])for(const [name,backend,linear]of backends)for(const complex of linear&&!description.includes(';')?[false,true]:[true]){
    const before=['-cpuflags','0','-f','rawvideo','-pixel_format',source,'-video_size','3x2','-framerate','25'],after=[...(complex?['-filter_complex',`[0:v]${description}[x]`,'-map','[x]']:['-vf',description]),...(linear?[]:['-fps_mode','passthrough','-enc_time_base','filter']),'-c:v','rawvideo','-bitexact','-f',format];
    const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),sink=collectingOutput();
    const result=await frontend(input,backend(),()=>sink.output).exec(['-y',...before,'-i','/in',...after,'/out']);const label=`${source}/${description}/${format}/${name}/${complex}`;
    expect(result.exitCode,JSON.stringify({label,result})).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected);expect(sink.committed).toBe(true);count++;
   }
  }
  expect(count).toBe(4*(3*5+4)*2);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('refuses epx output above maxFrameBytes and options native rejects before any output is opened',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-epx-reject-'));
 try{
  const input=concat(patterns(3,2).slice(0,2));writeFileSync(join(root,'input.raw'),input);const frame=decode(input.subarray(0,24),'rgba',3,2,0n);
  // Input fits, scaled output does not: 3x2 rgba is 24 bytes, epx3 is 216 bytes.
  expect(()=>epxVideoFrame(frame,parseEpxOptions(null),{maxFrameBytes:215})).toThrow('epx frame exceeds allocation limit');expect(epxVideoFrame(frame,parseEpxOptions(null),{maxFrameBytes:216}).planes[0]!.length).toBe(216);
  const plan=compileVideoFilterChain('epx').plan('rgba',3,2);expect(()=>plan.apply(frame,{maxFrameBytes:215,maxStateBytes:0})).toThrow();
  for(const options of ['n=1','n=4','n=0','n=-3','1','4'])expect(()=>parseEpxOptions(options),options).toThrow(VideoEpxError);
  for(const description of ['epx=n=1','epx=n=4','epx=enable=1','epx=foo=1']){
   const nativeRun=spawnSync(native,['-v','error','-f','rawvideo','-pixel_format','rgba','-s','3x2','-i',join(root,'input.raw'),'-vf',description,'-f','rawvideo','-'],{timeout:10000});expect(nativeRun.status,description).not.toBe(0);expect(nativeRun.stdout.length,description).toBe(0);
   for(const backend of [createMediaBackend({pixelArithmetic:'scalar'}),timedBackend('producer'),timedBackend('pull')]){
    let opened=0;const result=await frontend(input,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y','-f','rawvideo','-pixel_format','rgba','-video_size','3x2','-i','/in','-filter_complex',`[0:v]${description}[x]`,'-map','[x]','-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,description).not.toBe(0);expect(opened,description).toBe(0);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
