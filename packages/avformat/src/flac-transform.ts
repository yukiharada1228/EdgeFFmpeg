import {ExecutionError} from '@edge-ffmpeg/core';
import type {BackendContext,ReadHandle,ResourceContext} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import type {AudioFrameData,MediaPacket} from '@edge-ffmpeg/avutil';
import {getPcmFormat} from '@edge-ffmpeg/avcodec';
import {decodeFlacAudioFrames} from './flac-wave-frames.js';
import type {FlacAudioFramesMetadata} from './flac-wave-frames.js';
import {compileFlacTimePolicy,resolveFlacTimePolicy} from './flac-wave-time.js';
import type {FlacTimePolicy} from './flac-wave-time.js';
import {trimFlacAudio} from './flac-wave-trim.js';
import {remixFlacAudio} from './flac-wave-remix.js';
import {resampleFlacAudio} from './flac-wave-resample.js';
import {processFlacFilterRate} from './flac-filter-rate.js';
import {processTimedBufferedFlac} from './flac-timed-buffered.js';
import {resampleInternalFormat,remixInternalFormat} from '@edge-ffmpeg/swresample';
import {compileFlacAudioFilters,processFlacAudioFilters} from './flac-wave-filters.js';
import type {CompiledFlacAudioFilters} from './flac-wave-filters.js';
import {countFlacAudio,encodeFlacAudio} from './flac-wave-encode.js';
import {muxFlacOutput,validateFlacOutput} from './flac-output.js';
import type {FlacOutputConfiguration} from './flac-output.js';
import type {FlacBackendConfiguration} from './flac-decode.js';
import {assertOutputPolicy} from './output-policy.js';
import {openOutputGroup,OutputGroupError} from './output-group.js';

export interface FlacTransformPlan {
 readonly time:FlacTimePolicy;
 readonly timed:boolean;
 readonly channels:1|2|null;
 readonly rate:number|null;
 readonly scalar:boolean;
 readonly filters:CompiledFlacAudioFilters|null;
}
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
/** Snapshot and compile before the first provider await. */
export function compileFlacTransform(command:ParsedCommand,output:FlacOutputConfiguration):FlacTransformPlan|null{
 const input=command.inputs[0]!,target=command.outputs[0]!;
 const timed=[...input.options,...target.options].some(option=>['-ss','-t','-to'].includes(option.name));
 let channels:1|2|null=null,rate:number|null=null,description:string|null=null;
 for(const option of target.options){
  if(['-ac','-ac:a','-ac:a:0'].includes(option.name)){
   if(!/^[12]$/.test(option.value??''))unsupported('FLAC channel conversion currently supports mono/stereo');
   channels=Number(option.value) as 1|2;
  }else if(['-ar','-ar:a','-ar:a:0'].includes(option.name)){
   if(!/^\d+$/.test(option.value??'')||Number(option.value)<1||Number(option.value)>655350)unsupported('Unsupported FLAC output sample rate');
   rate=Number(option.value);
  }else if(['-af','-filter:a','-filter:a:0'].includes(option.name))description=option.value;
 }
 if(!timed&&channels===null&&rate===null&&description===null)return null;
 const time=compileFlacTimePolicy(command);
 const filters=description===null?null:compileFlacAudioFilters(description,channels===null?getPcmFormat(output.codec).sampleFormat:'flt',channels!==null);
 // Input duration precedes user filters; negotiated automatic rate conversion
 // can precede the trim. Finite buffering uses separate input/output trims;
 // timestamp and filter-rate stages still need their own Native scheduling.
 if(timed&&filters?.capabilities.some(capability=>!capability.timeSelection))unsupported('Combined FLAC time selection and filters/rate conversion require additional Native packet scheduling');
 // Untimed FLAC input runs every step too: a step without pinned FLAC evidence is refused before decoding.
 const unproven=filters?.steps.find((_,index)=>!filters.capabilities[index]!.flacInput);
 if(unproven)unsupported(`FLAC input to ${unproven.name} requires additional Native evidence`);
 return Object.freeze({time,timed,channels,rate,filters,scalar:command.global.filter(option=>option.name==='-cpuflags').at(-1)?.value==='0'});
}
function wait<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});void pending.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});if(signal.aborted){signal.removeEventListener('abort',abort);abort();}});
}

/** Run identical bounded transformation passes sequentially. No whole-stream
 * storage and never two live Wasm decoder reservations. */
export async function executeFlacTransform(reader:ReadHandle,context:BackendContext,resources:ResourceContext,configuration:FlacBackendConfiguration,plan:FlacTransformPlan,output:FlacOutputConfiguration,paths:{input:string;output:string},options:{frameLimit:bigint|null;overwrite:boolean;noOverwrite:boolean;bitexact:boolean}):Promise<readonly string[]>{
 const {signal,budget}=context,maxFrameBytes=configuration.maxFrameBytes??4194304,maxReadBytes=Math.min(configuration.maxReadBytes??65536,65536,budget.maxBufferBytes);
 const limits={resources,signal,maxFrameBytes:budget.maxBufferBytes};
 const open=()=>decodeFlacAudioFrames(configuration.module,reader,{resources,signal,maxFrameBytes,maxReadBytes});
 const transform=(source:AsyncIterable<AudioFrameData>,info:FlacAudioFramesMetadata):AsyncIterable<AudioFrameData>=>{
  let result=source;
  const filteredRate=plan.filters?.outputSampleRate(info.sampleRate)??info.sampleRate;
  const timedRate=plan.timed&&plan.rate!==null&&plan.rate!==filteredRate;
  const insertedRate=plan.rate!==null&&plan.rate!==filteredRate&&plan.filters?.has('formatConstraint');
  const rateBoundary=insertedRate?plan.filters!.rateBoundary(info.sampleFormat,info.sampleRate,plan.rate!):null;
  const inputTrimAfterRate=plan.timed&&rateBoundary?.beforeStep===0;
  const timedBuffered=plan.timed&&(plan.filters?.reframes??false);
  if(plan.timed&&!inputTrimAfterRate&&!timedBuffered){
   // Input recording time truncates the samples that feed FIR history. Output
   // seek must instead retain that history and drop the resampled prefix below.
   const time=timedRate?{input:plan.time.input,output:{seek:0n,duration:null,stop:null}}:plan.time;
   result=trimFlacAudio(result,resolveFlacTimePolicy(time,info.sampleRate,info.totalSamples===0n?null:info.totalSamples),limits);
  }
  if(plan.filters){
   const filterOptions={...limits,inputFormat:{sampleRate:info.sampleRate,channels:info.channels,channelLayout:info.channelLayout,sampleFormat:info.sampleFormat,pts:{value:0n,timeBase:info.timeBase}}};
   if(timedBuffered)result=processTimedBufferedFlac(result,plan.filters,plan.time,filterOptions.inputFormat,info.totalSamples===0n?null:info.totalSamples,limits);
   else result=insertedRate?processFlacFilterRate(result,plan.filters,info.sampleFormat,info.sampleRate,plan.rate!,filterOptions,inputTrimAfterRate?resolveFlacTimePolicy({input:plan.time.input,output:{seek:0n,duration:null,stop:null}},plan.rate!,null):undefined):processFlacAudioFilters(result,plan.filters,filterOptions);
  }
  const target=getPcmFormat(output.codec).sampleFormat;
  const inputFormat=plan.filters?.resolvedSampleFormat(info.sampleFormat)??info.sampleFormat;
  const internal=plan.rate!==null&&plan.rate!==filteredRate?resampleInternalFormat(inputFormat,target):target;
  if(plan.channels!==null&&plan.channels!==info.channels)result=remixFlacAudio(result,plan.channels,internal,{...limits,matrixSampleFormat:target,arithmetic:configuration.remixArithmetic??'separate'});
  if(plan.rate!==null&&!insertedRate)result=resampleFlacAudio(result,plan.rate,target,limits);
  if(timedRate){
   const time={input:{seek:0n,duration:null,stop:null},output:plan.time.output};
   // FIR draining can change the finite count, especially for short inputs.
   // Let actual resampled EOF bound output time rather than scaling STREAMINFO.
   result=trimFlacAudio(result,resolveFlacTimePolicy(time,plan.rate!,null),limits);
  }
  return result;
 };
 let stream=open(),initial:FlacAudioFramesMetadata;
 let counted:Awaited<ReturnType<typeof countFlacAudio>>;
 try{
  initial=await stream.prepare();
  if(plan.channels!==null&&(![1,2].includes(initial.channels)||initial.channelLayout!==(initial.channels===1?'mono':'stereo')))unsupported('FLAC channel conversion requires a canonical mono/stereo input layout');
  // Native format lists were negotiated for a channel conversion; without one, native merges the encoder format instead.
  if(plan.channels===initial.channels&&plan.filters?.nativeFormatLists)unsupported('FLAC -ac without channel conversion and native filter format lists require additional Native negotiation');
  const mixSource=plan.filters?.resolvedSampleFormat(initial.sampleFormat)??initial.sampleFormat;
  const filteredRate=plan.filters?.outputSampleRate(initial.sampleRate)??initial.sampleRate;
  const changingRate=plan.rate!==null&&plan.rate!==filteredRate;
  // FIR payload partitioning is a memory bound, not Native AVFrame scheduling.
  // Raw/container output can concatenate it; framecrc and frame limits cannot.
  if(changingRate&&(output.format==='framecrc'||options.frameLimit!==null))unsupported('FLAC resampled framecrc/frame limits require Native packet scheduling');
  if(changingRate&&plan.filters){
   const boundary=plan.filters.rateBoundary(initial.sampleFormat,initial.sampleRate,plan.rate!);
   const hasFormat=plan.filters.has('formatConstraint');
   if(hasFormat){
    if(boundary&&resampleInternalFormat(boundary.inputFormat,boundary.outputFormat)==='dbl'&&['dbl','dblp'].includes(getPcmFormat(output.codec).sampleFormat))unsupported('FLAC aformat rate conversion requires reproducible double-precision FIR coefficients');
    if(plan.filters.capabilities.some(capability=>!capability.stateless||capability.changesRate)||plan.channels!==null&&plan.channels!==initial.channels)unsupported('FLAC resampling with this filter placement requires additional Native scheduling');
   }else if(boundary?.beforeStep!==plan.filters.steps.length||plan.filters.capabilities.some(capability=>!capability.stateless))unsupported('FLAC resampling with this filter placement requires additional Native scheduling');
  }
  if(plan.filters){
   // Frame limit zero bypasses the transformation iterator entirely. Validate
   // metadata constraints here too, before counting or opening any output.
   const boundary=changingRate&&plan.filters.has('formatConstraint')?plan.filters.rateBoundary(initial.sampleFormat,initial.sampleRate,plan.rate!):null;
   plan.filters.validateInputFormat(initial,...(boundary?[{beforeStep:boundary.beforeStep,transform:(frames:AsyncIterable<AudioFrameData>)=>frames,outputFormat:{sampleRate:plan.rate!,channels:initial.channels,channelLayout:initial.channelLayout,sampleFormat:boundary.outputFormat,pts:null}}]:[]));
  }
  const scalarRequired=changingRate||plan.channels!==null&&plan.channels!==initial.channels&&remixInternalFormat(mixSource,getPcmFormat(output.codec).sampleFormat)!=='s16'||(plan.filters?.requiresScalarRounding(initial.sampleFormat)??false);
  if(scalarRequired&&!plan.scalar)unsupported('FLAC conversion requires -cpuflags 0 to pin scalar rounding and rematrix arithmetic');
  // The bridge can split large source frames for bounded raw output. Framecrc
  // and frame limits need original boundaries, so refuse ambiguous chunking.
  if((output.format==='framecrc'||options.frameLimit!==null)&&initial.maxBlockSamples*initial.channels*(initial.sampleFormat==='s16'?2:4)>budget.maxBufferBytes)unsupported('FLAC frame boundary exceeds buffer budget');
  counted=await countFlacAudio(transform(stream,initial),signal,options.frameLimit);
 }finally{await stream.close();}
 const channels=counted.audio?.channels??plan.channels??initial.channels;
 const sampleRate=counted.audio?.sampleRate??plan.rate??plan.filters?.outputSampleRate(initial.sampleRate)??initial.sampleRate;
 const channelLayout=counted.audio?.channelLayout??(channels===1?'mono':channels===2?'stereo':initial.channelLayout);
 const audio={channels,sampleRate,channelLayout,channelMask:channels===initial.channels?initial.channelMask:channels===1?4n:3n};
 validateFlacOutput(output,audio,counted.samples,{metadataProfile:'ffmpeg-9.0.2',bitexact:options.bitexact});
 let group:Awaited<ReturnType<typeof openOutputGroup>>|undefined;
 try{
  stream=open();const second=await stream.prepare();
  if(second.sampleRate!==initial.sampleRate||second.channels!==initial.channels||second.bitsPerSample!==initial.bitsPerSample||second.totalSamples!==initial.totalSamples||second.channelLayout!==initial.channelLayout||second.channelMask!==initial.channelMask)unsupported('FLAC metadata changed between transformation passes');
  await wait(assertOutputPolicy(context,paths.output,options.overwrite,options.noOverwrite),signal);
  const opening=openOutputGroup(context.filesystem,[paths.output],options.overwrite,signal);
  void opening.then(value=>{if(signal.aborted)void value.abort(signal.reason).catch(()=>{});},()=>{});
  group=await wait(opening,signal);
  async function* packets():AsyncIterable<MediaPacket>{
   let samples=0n,frames=0n;
   for await(const packet of encodeFlacAudio(transform(stream,second),output.codec,{...limits,frameLimit:options.frameLimit})){
    samples+=packet.duration!;frames++;yield packet;
   }
   if(samples!==counted.samples||frames!==counted.frames)throw new Error('FLAC transformed prepass mismatch');
  }
  const destination=group.writers[0]!;
  const writer={async write(bytes:Uint8Array){const release=resources.reserveExternalMemory(bytes.length);let pending:Promise<void>;try{pending=Promise.resolve(destination.write(bytes));}catch(error){release();throw error;}void pending.then(release,release);await wait(pending,signal);},commit:()=>wait(destination.commit(),signal),abort:(reason?:unknown)=>wait(destination.abort(reason),signal)};
  await muxFlacOutput(writer,output,audio,packets(),{sampleCount:counted.samples,maxWriteBytes:budget.maxBufferBytes,signal,metadataProfile:'ffmpeg-9.0.2',bitexact:options.bitexact});
  await wait(group.commit(),signal);return [paths.output];
 }catch(error){
  if(group&&!(error instanceof OutputGroupError))try{await wait(group.abort(error),signal);}catch(cleanup){throw new OutputGroupError('FLAC transform cleanup failed',group.effects(),error,[cleanup]);}
  throw error;
 }finally{await stream.close();}
}
