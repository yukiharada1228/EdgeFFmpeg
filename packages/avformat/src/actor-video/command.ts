import {probeRawRead,finishRawProbes} from '../raw-read-probe.js';
import type {InputReadError,ExecutionDiagnostic} from '@edge-ffmpeg/core';
import {assertOutputPolicy} from '../output-policy.js';
import {decodedRawVideoTimeRange} from '../video-output/input-rate-range.js';
import {resolveVideoCommandOptions,videoFallbackCommand} from '../video-output/option-order.js';
import {normalizeSimpleVideoCommand} from './simple-command.js';
import type {ReadHandle} from '@edge-ffmpeg/core';
import {parseArgv} from '@edge-ffmpeg/cli';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import {publishScheduledGraph} from "./publish-scheduled.js";
import {spoolSource} from "./spool-source.js";
import {createActorGraphExecution,createReadFramesActorGraphExecution,createQueuedReadFramesActorGraphExecution} from "./actor-execution.js";
import type {ExpressionNumericProfile,ExpressionPrint} from '@edge-ffmpeg/avutil';
import type {VirtualFileSystem,ResourceBudget} from '@edge-ffmpeg/core';import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';import {openRawVideo} from '@edge-ffmpeg/containers';import {decodeRawVideo} from '@edge-ffmpeg/avcodec';import {resolveDuration} from "../time-range.js";import {planTimedCommand} from "./command-plan.js";import {publishTimedGraphPull} from "./publish-pull.js";import {createSharedSpool} from "./spool/index.js";import type {Store} from "./spool/index.js";
/** Explicit timed rawvideo CLI path selected through createTimedVideoBackend. */
export async function executeParsedTimedVideoCommand(command:ParsedCommand,filesystem:VirtualFileSystem,budget:Readonly<ResourceBudget>,storage:(kind:'input'|'graph'|'output',index:number)=>Store<TimedVideoOutputEvent>,limits:{scheduler?:'pull'|'activation'|'read-frames'|'queued'|'scheduled'|'producer';numericProfile:ExpressionNumericProfile;onPrint?(node:number,entry:ExpressionPrint):void;logLevel?:number;maxEvents:number;signal?:AbortSignal;reportDiagnostic?:(diagnostic:ExecutionDiagnostic)=>void}){
 command=resolveVideoCommandOptions(command);
 limits={...limits};budget={...budget};if(limits.scheduler!==undefined&&!['pull','activation','read-frames','queued','scheduled','producer'].includes(limits.scheduler))throw new Error('Invalid timed video scheduler');
 const probedHandles=new Map<number,ReadHandle>(),readFailures=new Map<number,InputReadError>(),probeSignal=limits.signal??new AbortController().signal;
 if(!command.global.some(option=>option.name==='-filter_complex'||option.name==='-lavfi')){
  const original=command;command=normalizeSimpleVideoCommand(original);
  // Preflight unsupported syntax/options/geometry before opening input metadata.
  let provisional:ReturnType<typeof planTimedCommand>|undefined,firstError:unknown;
  const automatic=original.inputs.length>1&&original.outputs.some(output=>!output.options.some(option=>option.name==='-map'));
  for(const candidate of [undefined,...(automatic?original.inputs.map((_,index)=>index):[])]){
   try{provisional=planTimedCommand(candidate===undefined?command:normalizeSimpleVideoCommand(original,undefined,candidate),budget,limits.numericProfile==='linux-x64'?'x86_64':'aarch64',limits.numericProfile);break;}catch(error){firstError??=error;}
  }
  if(!provisional)throw firstError;
  if(automatic){
   const flags:boolean[]=[];
   for(const [index,source]of provisional.sources.entries()){limits.signal?.throwIfAborted();const accepted=await filesystem.openRead(source.path),probe=await probeRawRead(accepted,probeSignal),handle=probe.input;if(probe.failure)readFailures.set(index,probe.failure);probedHandles.set(index,handle);limits.signal?.throwIfAborted();flags.push(handle.size>0n);}
   command=normalizeSimpleVideoCommand(original,flags);
  }
 }
 const decodedInputs:boolean[]=[],plan=planTimedCommand(command,budget,limits.numericProfile==='linux-x64'?'x86_64':'aarch64',limits.numericProfile),spools:ReturnType<typeof createSharedSpool<TimedVideoOutputEvent>>[]=[],factories=Array<((signal:AbortSignal)=>AsyncIterable<TimedVideoOutputEvent>)>(plan.bindings.length);let disposed=false;
 const dispose=async()=>{if(disposed)return;disposed=true;const results=await Promise.allSettled(spools.map(spool=>spool.close()));const failures=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);for(const spool of spools){const outcome=await spool.closed;if(outcome.status==='error')failures.push(outcome.error,...outcome.secondaryErrors);}if(failures.length)throw new AggregateError([...new Set(failures)],'Physical input spool cleanup failed');};
 try{
  const policyContext={filesystem,budget,signal:probeSignal,...(limits.reportDiagnostic?{reportDiagnostic:limits.reportDiagnostic}:{})};
  for(const [index,source]of plan.sources.entries()){
   policyContext.signal.throwIfAborted();const accepted=probedHandles.get(index)??await filesystem.openRead(source.path),probe=await probeRawRead(accepted,policyContext.signal),handle=probe.input;if(probe.failure)readFailures.set(index,probe.failure);probedHandles.set(index,handle);policyContext.signal.throwIfAborted();
   await openRawVideo(handle,{...source.parameters,frameRate:source.demuxFrameRate,maxReadBytes:budget.maxBufferBytes,maxFrameBytes:budget.maxBufferBytes,signal:policyContext.signal});
  }
  for(const output of plan.outputs)await assertOutputPolicy(policyContext,output.path,plan.overwrite,plan.noOverwrite);
  finishRawProbes(command,policyContext,Array.from(readFailures).filter(([index])=>plan.bindings.includes(index)).map(([,failure])=>failure));
  for(const [index,source]of plan.sources.entries()){

   const uses=plan.bindings.flatMap((binding,pad)=>binding===index?[pad]:[]);if(!uses.length)continue;
   const spool=createSharedSpool(signal=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{const handle=probedHandles.get(index)??await filesystem.openRead(source.path),video=await openRawVideo(handle,{...source.parameters,frameRate:source.demuxFrameRate,maxReadBytes:budget.maxBufferBytes,maxFrameBytes:budget.maxBufferBytes,signal}),range=decodedRawVideoTimeRange(video.info.frameCount,source.demuxFrameRate,source.parameters.frameRate,source.forcedFrameRate,source.time,{seek:0n,duration:null,stop:null},{copyTs:source.copyTs,frameBytes:source.frameBytes,inputSeekSet:source.inputSeekSet,copy:false,outputSeekSet:false,maxFrames:null});let count=0n,last:bigint|null=null;if(range.initializationStart!==undefined)for await(const packet of video.packets(range.initializationStart,1n)){decodeRawVideo(packet,source.parameters,{maxFrameBytes:budget.maxBufferBytes,signal});decodedInputs[index]=true;}
    for await(const packet of video.packets(range.start,range.frames)){signal.throwIfAborted();const pts=range.ptsForFrame(count++);decodedInputs[index]=true;last=pts;yield {kind:'frame',frame:decodeRawVideo({...packet,pts,dts:pts,timeBase:{num:source.parameters.frameRate.den,den:source.parameters.frameRate.num}},source.parameters,{maxFrameBytes:budget.maxBufferBytes,signal}),duration:1n};}const pts=last===null?null:last+1n;yield {kind:'end',status:'eof',pts,rawPts:pts,inputPts:pts,secondaryErrors:[]};}}),storage('input',index),{readers:limits.scheduler==='queued'||limits.scheduler==='scheduled'||limits.scheduler==='producer'?1:uses.length,maxEvents:limits.maxEvents,terminal:event=>event.kind==='end',...(limits.signal?{signal:limits.signal}:{})});spools.push(spool);for(const [reader,pad]of uses.entries())factories[pad]=signal=>spoolSource(()=>spool.open(limits.scheduler==='queued'||limits.scheduler==='scheduled'||limits.scheduler==='producer'?0:reader),signal);
  }
  const outputs=plan.graphPlan.sinks.map((_,pad)=>{const output=plan.outputs.find(output=>output.pad===pad)!,clock=plan.graphPlan.clocks[plan.graphPlan.graph.outputs[pad]!.node]!,source=clock.demuxSource===null?undefined:plan.sources[plan.bindings[clock.demuxSource]!]!;return {emptyFilterTimeBase:()=>planTimedCommand(videoFallbackCommand(command,decodedInputs),budget,limits.numericProfile==='linux-x64'?'x86_64':'aarch64',limits.numericProfile).graphPlan.sinks[pad]!.timeBase,path:output.path,framecrc:output.format==='framecrc',bitexact:output.bitexact,mode:output.mode,...(output.outputFrameRate?{outputFrameRate:output.outputFrameRate}:{}),...(output.outputMaxFrameRate?{outputMaxFrameRate:output.outputMaxFrameRate}:{}),...(output.encoderTimeBase?{encoderTimeBase:output.encoderTimeBase}:{}),...(source?{demuxTimeBase:{num:source.demuxFrameRate.den,den:source.demuxFrameRate.num}}:{}),...(output.frames===null?{}:{maxFrames:output.frames}),startUs:output.time.seek,durationUs:resolveDuration(output.time)};});
  await (limits.scheduler==='scheduled'||limits.scheduler==='producer'?publishScheduledGraph:publishTimedGraphPull)(plan.graphPlan,factories,index=>storage('graph',index),filesystem,outputs,{...plan.executionBudget,numericProfile:limits.numericProfile,...(limits.onPrint?{onPrint:limits.onPrint}:{}),...(limits.logLevel===undefined?{}:{logLevel:limits.logLevel}),arithmetic:plan.arithmetic,maxEvents:limits.maxEvents,maxWriteBytes:budget.maxBufferBytes,overwrite:plan.overwrite,...(limits.signal?{signal:limits.signal}:{}),lookahead:1,encoderSyncQueue:limits.scheduler==='read-frames'||limits.scheduler==='queued',inputGroups:plan.bindings,beforePublish:dispose,...(limits.scheduler==='producer'?{producerAhead:true}:{}),...(limits.scheduler==='activation'?{executionFactory:createActorGraphExecution}:limits.scheduler==='read-frames'?{executionFactory:createReadFramesActorGraphExecution}:limits.scheduler==='queued'?{executionFactory:createQueuedReadFramesActorGraphExecution}:{})});return plan.outputs.map(output=>output.path);
 }catch(error){try{await dispose();}catch(cleanup){throw new AggregateError([error,cleanup],'Timed command and physical input cleanup failed');}throw error;}
}

type ExecutionArguments=Parameters<typeof executeParsedTimedVideoCommand> extends [unknown,...infer Rest]?Rest:never;
export function executeTimedVideoCommand(argv:readonly string[],...args:ExecutionArguments){return executeParsedTimedVideoCommand(parseArgv(argv),...args);}
