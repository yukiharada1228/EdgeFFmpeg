import {expect} from 'vitest';
import {execFile} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,videoStoragePixelFormat as storage} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoScheduler} from '@edge-ffmpeg/avformat';
import {executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
import {runBoundedCases} from './native-oracle.js';
import {collectingOutput} from './output.js';
const native=resolve('.build/reference/ffmpeg'),time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725,budget={maxFrameBytes:1<<18,maxStateBytes:1<<22,maxResidentBytes:1<<24};
/** Every format the CLI and the five paths accept as a source, and the legacy JPEG-range sources only linear chains accept. */
export const negotiationSources=['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','argb','rgba','abgr','bgra','yuva420p','gbrp','yuvj420p','yuvj422p','yuvj444p'] as const;
const legacy=(format:string)=>storage(format)!==format;
const run=(args:readonly string[],signal:AbortSignal)=>new Promise<{stdout:Buffer;stderr:string}>((done,fail)=>{execFile(native,['-hide_banner','-nostats','-cpuflags','0',...args],{encoding:'buffer',maxBuffer:1<<22,signal},(error,stdout,stderr)=>{if(error)fail(new Error(`${args.join(' ')}: ${stderr.toString()}`));else done({stdout,stderr:stderr.toString()});});});
const bytes=(format:string,width:number,height:number,frames:number,seed:number)=>Uint8Array.from({length:pixelLayout(storage(format),width,height).bytes*frames},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
const concat=(chunks:readonly Uint8Array[])=>Buffer.concat(chunks.map(chunk=>Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength)));
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return concat(layout.planes.flatMap((plane,index)=>Array.from({length:plane.height},(_,row)=>frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))));};
const memoryStore=():Store<TimedVideoOutputEvent>=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,value);},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
/** Two frames through each path's public entry point; every planner runs before the first frame is produced.
 * Legacy yuvj sources exist only on linear chains, as a planar frame named by its legacy format. */
function paths(format:string,width:number,height:number,data:Uint8Array){
 const size=pixelLayout(storage(format),width,height).bytes,frame=(n:number):VideoFrameData=>{
  if(!legacy(format))return decodeRawVideo({streamIndex:0,data:data.subarray(n*size,(n+1)*size),pts:BigInt(n),dts:null,duration:1n,timeBase:time,flags:1},{pixelFormat:format,width,height},{maxFrameBytes:1<<18});
  const layout=pixelLayout(storage(format),width,height),bytes=data.subarray(n*size,(n+1)*size);return {width,height,pixelFormat:format,planes:layout.planes.map(plane=>bytes.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:{value:BigInt(n),timeBase:time},metadata:{}};
 };
 const linear={async linear(vf:string){const plan=compileVideoFilterChain(vf).plan(format,width,height,{arithmetic:'scalar'});return [0,1].map(n=>plan.apply(frame(n),{maxFrameBytes:budget.maxFrameBytes,maxStateBytes:plan.stateBytes}));}};
 if(legacy(format))return linear;
 const shape={format,width,height},source={geometry:shape,timeBase:time,frameRate:rate},timedSource=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(let n=0;n<2;n++)yield {kind:'frame',frame:frame(n),duration:1n};yield {kind:'end',status:'eof',pts:2n,rawPts:2n,inputPts:null,secondaryErrors:[]};}});
 return {...linear,
  async graph(vf:string){const plan=compileVideoFilterGraph(`[0:v]${vf}[o]`).plan(shape,[null],{arithmetic:'scalar'});return [0,1].map(n=>plan.apply(frame(n),budget)[0]!);},
  async stream(vf:string){const execution=createReplayVideoExecution(`[0:v]${vf}[o]`,[{geometry:shape,timeBase:time,async *open(){for(let n=0;n<2;n++)yield frame(n);}}],[null],{...budget,maxSourceTraversals:16},{arithmetic:'scalar'});
   try{const frames:VideoFrameData[]=[];for await(const value of execution.outputs[0]!.frames)frames.push(value);return frames;}finally{await execution.close();}},
  async actor(vf:string){const actors=createFrameActors(vf,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:budget.maxFrameBytes,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]});
   try{for(let n=0;n<2;n++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:frame(n)});actors.endInput(0,EOF,2n);const frames:VideoFrameData[]=[];
    for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);return frames;}frames.push(result.event!.frame);}throw new Error('Actor output did not end');}finally{actors.dispose();}},
  async timed(vf:string){const frames:VideoFrameData[]=[];await executeTimedGraph(planTimedVideoGraph(vf,[source],[null]),[timedSource],memoryStore,{numericProfile:'linux-x64',maxFrameBytes:budget.maxFrameBytes,maxStateBytes:budget.maxStateBytes,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<20,maxOperatorSteps:4096,async frame(_output,event){frames.push(event.frame);}});return frames;},
 };
}
const timedBackend=(scheduler:TimedVideoScheduler)=>createTimedVideoBackend({storage:()=>memoryStore(),limits:{numericProfile:'linux-x64',maxEvents:256,scheduler}});
const frontend=(input:Uint8Array,backend:ExecutionBackend,open:()=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,13));}};},async openWrite(){return open();}},backend,budget:{maxResidentBytes:8*1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
export interface NegotiationOutcome {readonly matched:Readonly<Record<string,string>>;readonly refused:Readonly<Record<string,string>>;readonly checks:number}
/** For each source, reads the format native negotiates on the link after `vf` (showinfo stands after the operator, whose input and
 * output share one list), then requires either the same pick here with native's rawvideo bytes on every path (-cpuflags 0, scalar
 * arithmetic), or, when the pick has no frame storage here, the plan-time refusal naming exactly that format on every path and on the
 * CLI (media -vf and -filter_complex, timed producer and pull) with no output opened. Legacy yuvj sources run on linear chains only.
 * Returns source -> native format for both outcomes so the caller pins them exactly. */
export async function nativeNegotiationOutcome(vf:string,sources:readonly string[],signal:AbortSignal,width=8,height=6):Promise<NegotiationOutcome> {
 const root=mkdtempSync(join(tmpdir(),'edge-video-negotiation-cases-')),matched:Record<string,string>={},refused:Record<string,string>={};let checks=0;
 try{
  await runBoundedCases(sources,4,signal,async(source,caseSignal)=>{
   const data=bytes(source,width,height,2,source.length*131+vf.length),file=join(root,`${source}.raw`),input=['-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',file];writeFileSync(file,data);
   const log=(await run(['-v','info',...input,'-vf',`${vf},showinfo`,'-f','null','-'],caseSignal)).stderr,shown=/ fmt:(\S+) /.exec(log)?.[1];if(!shown)throw new Error(`showinfo printed no format for ${source}`);
   const label=`${source}/${vf}`,execute=paths(source,width,height,data);
   // A legacy pick runs only when its producer reads a legacy link: pass-through or yuvj-to-yuvj conversion keeps the forced full range.
   if(executableFormat(storage(shown))&&(!legacy(shown)||legacy(source))){
    const expected=(await run(['-v','error',...input,'-vf',vf,'-f','rawvideo','-'],caseSignal)).stdout;
    for(const [path,frames]of Object.entries(execute)){const output=await frames(vf);expect(output.map(frame=>frame.pixelFormat),`${label}/${path}`).toEqual([storage(shown),storage(shown)]);expect(concat(output.map(tight)),`${label}/${path}`).toEqual(expected);checks++;}
    matched[source]=shown;return;
   }
   const message=`negotiates ${shown}, which is not implemented`;
   for(const [path,frames]of Object.entries(execute)){await expect(frames(vf),`${label}/${path}`).rejects.toThrow(message);checks++;}
   if(!legacy(source))for(const [backend,args]of [[createMediaBackend({pixelArithmetic:'scalar'}),['-vf',vf]],[createMediaBackend({pixelArithmetic:'scalar'}),['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']],[timedBackend('producer'),['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']],[timedBackend('pull'),['-filter_complex',`[0:v]${vf}[x]`,'-map','[x]']]] as const){
    let opened=0;const result=await frontend(data,backend,()=>{opened++;return collectingOutput().output;}).exec(['-y','-f','rawvideo','-pixel_format',source,'-video_size',`${width}x${height}`,'-i','/in',...args,'-c:v','rawvideo','-f','rawvideo','/out']);
    expect(result.exitCode,`${label}/${args[0]}`).not.toBe(0);expect(opened,`${label}/${args[0]}`).toBe(0);expect(result.diagnostics.at(-1)?.message,`${label}/${args[0]}`).toContain(message);checks++;
   }
   refused[source]=shown;
  });
  const sorted=(value:Record<string,string>)=>Object.fromEntries(sources.filter(source=>source in value).map(source=>[source,value[source]!]));
  return {matched:sorted(matched),refused:sorted(refused),checks};
 }finally{rmSync(root,{recursive:true,force:true});}
}
