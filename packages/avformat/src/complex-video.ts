import {probeRawRead,finishRawProbes} from './raw-read-probe.js';
import {assertOutputPolicy} from './output-policy.js';
import {ExecutionExit} from '@edge-ffmpeg/core';
import {videoTimestampFlag} from './video-output/timestamp-options.js';
import {hasForcedVideoRate} from './video-output/option-order.js';
import {compileMultiInputVideoFilterGraph} from '@edge-ffmpeg/avfilter';
import {PacketQueue} from '@edge-ffmpeg/core';
import type {BackendContext,MediaPacket} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import {openRawVideo,muxRawVideo,muxRawVideoFrameCrc} from '@edge-ffmpeg/containers';
import {decodeRawVideo,encodeRawVideo} from '@edge-ffmpeg/avcodec';
import {complexVideoTimeRange} from './complex-video-time.js';
import {planComplexCommand} from './complex-video-plan.js';
import {openOutputGroup,OutputGroupError} from './output-group.js';
import {ComplexVideoFailure} from './complex-video-failure.js';
export {ComplexVideoFailure} from './complex-video-failure.js';
import {executeMultiVideo} from './multi-video.js';
/** Staged single-source complex graph runner. All output muxers prepare before publication. */
export async function executeComplexVideo(command:ParsedCommand,context:BackendContext,arithmetic:PixelArithmetic='aarch64'):Promise<readonly string[]>{
 const description=command.global.find(option=>['-filter_complex','-lavfi'].includes(option.name))?.value;
 if(command.global.some(option=>videoTimestampFlag(option.name))||[...command.inputs,...command.outputs].some(file=>file.options.some(option=>['-ss','-to'].includes(option.name)&&option.value?.startsWith('-')))||command.inputs.some(hasForcedVideoRate)||command.inputs.length!==1||command.outputs.some(file=>file.options.some(option=>['-r','-fpsmax','-fps_mode','-enc_time_base'].includes(option.name.split(':')[0]!)))||description&&compileMultiInputVideoFilterGraph(description).graph.inputs.length!==1)return executeMultiVideo(command,context,arithmetic);
 const plan=planComplexCommand(command,context.budget,arithmetic),controller=new AbortController(),onAbort=()=>controller.abort(context.signal.reason);context.signal.addEventListener('abort',onAbort,{once:true});if(context.signal.aborted)onAbort();const signal=controller.signal;
 let group:Awaited<ReturnType<typeof openOutputGroup>>|undefined;const tasks:Promise<unknown>[]=[],queues:PacketQueue<MediaPacket>[]=[];
 const stop=(error:unknown):never=>{if(!signal.aborted)controller.abort(error);throw error;};
 try{
  signal.throwIfAborted();const acceptedInput=await context.filesystem.openRead(plan.inputPath),rawProbe=await probeRawRead(acceptedInput,signal),input=rawProbe.input;signal.throwIfAborted();const video=await openRawVideo(input,{...plan.parameters,maxReadBytes:context.budget.maxBufferBytes,maxFrameBytes:context.budget.maxBufferBytes,signal}),ranges=plan.outputs.map(output=>complexVideoTimeRange(video.info.frameCount,plan.parameters.frameRate,plan.inputTime,output.time,{format:output.format,frameBytes:video.info.frameBytes,inputSeekSet:plan.inputSeekSet,outputSeekSet:output.outputSeekSet,maxFrames:output.frames}));
  for(const output of plan.outputs)await assertOutputPolicy(context,output.path,plan.overwrite,plan.noOverwrite);
  finishRawProbes(command,context,rawProbe.failure?[rawProbe.failure]:[]);
  group=await openOutputGroup(context.filesystem,plan.outputs.map(output=>output.path),plan.overwrite,signal);
  const closeAt=ranges.map(range=>range.start+range.sourceFrames),intervals=ranges.filter(range=>range.sourceFrames>0n).map(range=>({start:range.start,end:range.start+range.sourceFrames})).sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:0),windows:{start:bigint;end:bigint}[]=[];
  for(const interval of intervals){const last=windows.at(-1);if(last&&interval.start<=last.end){if(interval.end>last.end)last.end=interval.end;}else windows.push({...interval});}
  for(const [index,output]of plan.outputs.entries()){
   const queue=new PacketQueue<MediaPacket>(1,()=>{},signal);queues.push(queue);if(!ranges[index]!.frames)queue.close();const geometry=plan.graphPlan.negotiated.sinks[output.pad]!,parameters={width:geometry.width,height:geometry.height,pixelFormat:geometry.format,frameRate:plan.parameters.frameRate},range=ranges[index]!,options={metadataProfile:'ffmpeg-9.0.2' as const,frameCount:range.frames,timestamp:range.ptsForFrame,duration:range.durationForFrame,maxWriteBytes:context.budget.maxBufferBytes,bitexact:output.bitexact,signal};
   tasks.push((output.format==='framecrc'?muxRawVideoFrameCrc:muxRawVideo)(group.writers[index]!,parameters,queue,options).catch(stop));
  }
  const produce=async()=>{
   for(const window of windows){const iterator=video.packets(window.start,window.end-window.start)[Symbol.asyncIterator]();let completed=false;
    try{for(let position=window.start;position<window.end;position++){
     signal.throwIfAborted();const active=plan.outputs.flatMap((_,index)=>position>=ranges[index]!.start&&position<closeAt[index]!?[index]:[]),reservations:Awaited<ReturnType<PacketQueue<MediaPacket>['reserve']>>[]=[];
     try{
      for(const index of active)reservations.push(await queues[index]!.reserve());signal.throwIfAborted();const next=await iterator.next();signal.throwIfAborted();if(next.done)throw new Error('Rawvideo source ended before planned graph range');
      const decoded=decodeRawVideo(next.value,plan.parameters,{maxFrameBytes:context.budget.maxBufferBytes,signal}),frames=plan.graphPlan.apply(decoded,{maxFrameBytes:context.budget.maxBufferBytes,maxStateBytes:plan.graphPlan.stateBytes,maxResidentBytes:context.budget.maxResidentBytes,signal});
      for(const [slot,index]of active.entries()){const output=plan.outputs[index]!,range=ranges[index]!,relative=position-range.start,frame=frames[output.pad]!,indices=range.indicesForSource(relative);for(const [copy,outputIndex]of indices.entries()){signal.throwIfAborted();const reservation=copy===0?reservations[slot]!:await queues[index]!.reserve();if(copy>0)reservations.push(reservation);const pts=range.ptsForFrame(outputIndex),packet=encodeRawVideo({...frame,pts:{value:pts,timeBase:{num:plan.parameters.frameRate.den,den:plan.parameters.frameRate.num}}},plan.parameters.frameRate,{maxFrameBytes:context.budget.maxBufferBytes,signal});reservation.publish({...packet,pts,dts:pts,duration:range.durationForFrame(outputIndex)});if(outputIndex+1n===range.frames)queues[index]!.close();}}
     }finally{for(const reservation of reservations)reservation.release();}
    }const end=await iterator.next();if(!end.done)throw new Error('Rawvideo graph range exceeded planned frame count');completed=true;}
    finally{if(!completed)await iterator.return?.();}
   }
   for(const queue of queues)queue.close();
  };
  tasks.push(produce().catch(stop));await Promise.all(tasks);signal.throwIfAborted();await group.commit();return Object.freeze(plan.outputs.map(output=>output.path));
 }catch(error){if(error instanceof ExecutionExit&&!group&&!tasks.length)throw error;if(!signal.aborted)controller.abort(error);await Promise.allSettled(tasks);if(error instanceof OutputGroupError)throw error;const cleanupErrors:unknown[]=[];if(group)try{await group.abort(error);}catch(cleanup){cleanupErrors.push(cleanup);}throw new ComplexVideoFailure(error,group?.effects()??Object.freeze([]),Object.freeze(cleanupErrors));}
 finally{context.signal.removeEventListener('abort',onAbort);for(const queue of queues)queue.cancel(signal.aborted?signal.reason:new Error('Complex graph finished'));}
}
