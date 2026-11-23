import {probeRawRead,finishRawProbes} from './raw-read-probe.js';
import type {InputReadError} from '@edge-ffmpeg/core';
import {assertOutputPolicy} from './output-policy.js';
import {ExecutionExit} from '@edge-ffmpeg/core';
import {decodedRawVideoTimeRange} from './video-output/input-rate-range.js';
import type {BackendContext} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import type {MediaPacket,VideoFrameData,Rational} from '@edge-ffmpeg/avutil';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import {openRawVideo} from '@edge-ffmpeg/containers';
import {decodeRawVideo,encodeRawVideo} from '@edge-ffmpeg/avcodec';
import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import {planMultiCommand} from './multi-video-plan.js';
import {muxTimedRawVideo} from './multi-video-mux.js';
import {videoGraphClocks} from './video-output/graph-clock.js';
import {initializeVideoOutput} from './video-output/output-initialization.js';
import {synchronizeVideoOutput} from './video-output/output-stream.js';
import type {SyncFrame} from './video-output/sync.js';
import {videoPacketDuration} from './video-output/packet-duration.js';

import {resolveDuration} from './time-range.js';
import {openOutputGroup,OutputGroupError} from './output-group.js';
import {ComplexVideoFailure} from './complex-video-failure.js';
export async function executeMultiVideo(command:ParsedCommand,context:BackendContext,arithmetic:PixelArithmetic='aarch64'):Promise<readonly string[]>{
 const plan=planMultiCommand(command,context.budget,arithmetic),controller=new AbortController(),onAbort=()=>controller.abort(context.signal.reason);context.signal.addEventListener('abort',onAbort,{once:true});if(context.signal.aborted)onAbort();const signal=controller.signal;
 let group:Awaited<ReturnType<typeof openOutputGroup>>|undefined,replay:ReturnType<typeof createReplayVideoExecution>|undefined;const tasks:Promise<unknown>[]=[];
 try{
  const readFailures=new Map<number,InputReadError>();
  const physical:(ReplayVideoSource&{decoded:boolean;readonly frameRate:Rational;readonly demuxTimeBase:Rational})[]=[];for(const source of plan.sources){signal.throwIfAborted();const acceptedHandle=await context.filesystem.openRead(source.path),rawProbe=await probeRawRead(acceptedHandle,signal),handle=rawProbe.input;if(rawProbe.failure)readFailures.set(physical.length,rawProbe.failure);signal.throwIfAborted();const video=await openRawVideo(handle,{...source.parameters,frameRate:source.demuxFrameRate,maxReadBytes:context.budget.maxBufferBytes,maxFrameBytes:context.budget.maxBufferBytes,signal}),range=decodedRawVideoTimeRange(video.info.frameCount,source.demuxFrameRate,source.parameters.frameRate,source.forcedFrameRate,source.time,{seek:0n,duration:null,stop:null},{copyTs:source.copyTs,frameBytes:source.frameBytes,inputSeekSet:source.inputSeekSet,copy:false,outputSeekSet:false,maxFrames:null});
   const physicalIndex=physical.length;physical.push({decoded:false,geometry:source.geometry,timeBase:{num:source.parameters.frameRate.den,den:source.parameters.frameRate.num},demuxTimeBase:video.info.timeBase,frameRate:source.parameters.frameRate,readBufferBytes:3*source.frameBytes,async *open(){let index=0n;if(range.initializationStart!==undefined)for await(const packet of video.packets(range.initializationStart,1n)){decodeRawVideo(packet,source.parameters,{maxFrameBytes:context.budget.maxBufferBytes,signal});physical[physicalIndex]!.decoded=true;}for await(const packet of video.packets(range.start,range.frames)){signal.throwIfAborted();const pts=range.ptsForFrame(index++);physical[physicalIndex]!.decoded=true;yield decodeRawVideo({...packet,pts,dts:pts,timeBase:{num:source.parameters.frameRate.den,den:source.parameters.frameRate.num}},source.parameters,{maxFrameBytes:context.budget.maxBufferBytes,signal});}}});
  }
  for(const output of plan.outputs)await assertOutputPolicy(context,output.path,plan.overwrite,plan.noOverwrite);
  finishRawProbes(command,context,Array.from(readFailures).filter(([index])=>plan.bindings.includes(index)).map(([,failure])=>failure));
  const ordered=plan.bindings.map(index=>physical[index]!),clocks=videoGraphClocks(plan.description,ordered);replay=createReplayVideoExecution(plan.description,ordered,plan.targets,{...plan.replayBudget,signal},{arithmetic:plan.arithmetic,inputTrim:plan.bindings.map(index=>plan.sources[index]!.inputTrim),outputSizes:plan.sizes});
  group=await openOutputGroup(context.filesystem,plan.outputs.map(output=>output.path),plan.overwrite,signal);
  for(const [index,output]of plan.outputs.entries()){
   const flow=replay.outputs[output.pad]!,link=clocks.outputs[output.pad]!,clockOptions={mode:output.mode,sinkFrameRate:link.frameRate,filterTimeBase:link.timeBase,...(output.outputMaxFrameRate?{outputMaxFrameRate:output.outputMaxFrameRate}:{}),...(output.outputFrameRate?{outputFrameRate:output.outputFrameRate}:{}),...(output.encoderTimeBase?{encoderTimeBase:output.encoderTimeBase}:{}),...(link.durationSource===null?{}:{demuxTimeBase:ordered[link.durationSource]!.demuxTimeBase})};
   async function* filtered():AsyncIterable<SyncFrame<VideoFrameData>>{for await(const frame of flow.frames)yield {payload:frame,pts:frame.pts!,duration:link.durationSource===null?0n:1n};}
   tasks.push((async()=>{const initialized=await initializeVideoOutput(filtered(),{...clockOptions,emptyFilterTimeBase:()=>videoGraphClocks(plan.description,ordered.map(source=>source.decoded?source:{...source,timeBase:source.demuxTimeBase,frameRate:{num:source.demuxTimeBase.den,den:source.demuxTimeBase.num}})).outputs[output.pad]!.timeBase,startUs:output.time.seek,durationUs:resolveDuration(output.time),signal}),clock=initialized.clock,encoderRate={num:clock.timeBase.den,den:clock.timeBase.num};let failed=false;try{
   async function* packets():AsyncIterable<MediaPacket>{for await(const run of synchronizeVideoOutput(initialized.frames,{mode:clock.mode,filterTimeBase:link.timeBase,encoderTimeBase:clock.timeBase,sinkFrameRate:link.frameRate,startUs:output.time.seek,durationUs:resolveDuration(output.time),maxFrames:output.frames,signal}))for(let copy=0n;copy<run.count;copy++){signal.throwIfAborted();const pts=run.firstPts+copy,packet=encodeRawVideo({...run.payload,pts:{value:pts,timeBase:clock.timeBase}},encoderRate,{maxFrameBytes:context.budget.maxBufferBytes,signal});yield {...packet,pts,dts:pts,timeBase:clock.timeBase,duration:videoPacketDuration(run.duration,clock.frameRate,clock.timeBase)};}}
   await muxTimedRawVideo(group!.writers[index]!,packets(),{width:flow.geometry.width,height:flow.geometry.height,pixelFormat:flow.geometry.format,timeBase:clock.timeBase,framecrc:output.format==='framecrc',bitexact:output.bitexact,maxWriteBytes:context.budget.maxBufferBytes,signal});}catch(error){failed=true;throw error;}finally{try{await initialized.close();}catch(error){if(!failed)throw error;}}})().catch(error=>{if(!signal.aborted)controller.abort(error);throw error;}));
  }
  await Promise.all(tasks);signal.throwIfAborted();await replay.close();await group.commit();return Object.freeze(plan.outputs.map(output=>output.path));
 }catch(error){if(error instanceof ExecutionExit&&!group&&!replay&&!tasks.length)throw error;if(!signal.aborted)controller.abort(error);await Promise.allSettled(tasks);const cleanupErrors:unknown[]=[];if(replay)try{await replay.close();}catch(cleanup){cleanupErrors.push(cleanup);}if(error instanceof OutputGroupError)throw error;if(group)try{await group.abort(error);}catch(cleanup){cleanupErrors.push(cleanup);}throw new ComplexVideoFailure(error,group?.effects()??Object.freeze([]),Object.freeze(cleanupErrors));}
 finally{context.signal.removeEventListener('abort',onAbort);}
}
