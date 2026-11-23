import {compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFilterChain,AudioFilterCountPlan,AudioPadFormat} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';

export interface FlacAudioFilterPlan extends AudioFilterCountPlan {
 readonly outputRate:number;
 /** Filter output, before the separately owned PCM encoder conversion. */
 readonly sampleFormat:AudioSampleFormat;
 readonly encoderSampleFormat:AudioSampleFormat;
 readonly requiresScalarRounding:boolean;
}
export interface CompiledFlacAudioFilters extends AudioFilterChain {
 readonly encoderSampleFormat:AudioSampleFormat;
 plan(inputSamples:bigint,inputRate:number,inputFormat:AudioSampleFormat):FlacAudioFilterPlan;
}
export interface FlacAudioFilterOptions {
 readonly resources:ResourceContext;
 readonly signal:AbortSignal;
 readonly maxFrameBytes:number;
 /** Decoded source format, including the origin used for empty-stream padding. */
 readonly inputFormat?:AudioPadFormat;
}
const widths:Readonly<Record<AudioSampleFormat,number>>=Object.freeze({u8:1,s16:2,s32:4,flt:4,dbl:8,u8p:1,s16p:2,s32p:4,fltp:4,dblp:8});
function sampleFormat(value:string):AudioSampleFormat {
 if(!Object.hasOwn(widths,value))throw new RangeError('Unsupported FLAC filter sample format');
 return value as AudioSampleFormat;
}
function rate(value:number):void {
 if(!Number.isInteger(value)||value<1||value>2147483647)throw new RangeError('Invalid FLAC filter sample rate');
}
/** Only the existing finite, constant, single-input audio filter subset is accepted. */
export function compileFlacAudioFilters(description:string,outputFormat:AudioSampleFormat):CompiledFlacAudioFilters {
 sampleFormat(outputFormat);
 const chain=compileAudioFilterChain(description,{outputSampleFormat:outputFormat});
 return Object.freeze({...chain,encoderSampleFormat:outputFormat,
  plan(inputSamples:bigint,inputRate:number,inputFormat:AudioSampleFormat):FlacAudioFilterPlan {
   rate(inputRate);sampleFormat(inputFormat);
   return Object.freeze({...chain.planSamples(inputSamples,inputRate),outputRate:chain.outputSampleRate(inputRate),sampleFormat:chain.resolvedSampleFormat(inputFormat),encoderSampleFormat:outputFormat,requiresScalarRounding:chain.requiresScalarRounding(inputFormat)});
  }
 });
}
/** Observe both outcomes even after cancellation, without waiting for an uncooperative source. */
function wait<T>(pending:Promise<T>,signal:AbortSignal):Promise<T> {
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  void pending.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});
  if(signal.aborted)abort();
 });
}
/**
 * Single-consumer borrowed-frame stream. Consume/copy each result before next().
 * Input planes remain owned by the producer; allocating filter nodes are covered
 * by a real Core reservation acquired BEFORE any filter allocation, including
 * padding generated from a configured empty source.
 * The bounded resident envelope remains reserved across yields, and is released
 * on EOF, error, cancellation or return(). Retaining results is caller-owned.
 * This helper neither opens nor publishes output files.
 */
export async function* processFlacAudioFilters(frames:AsyncIterable<AudioFrameData>,compiled:CompiledFlacAudioFilters,options:FlacAudioFilterOptions):AsyncIterable<AudioFrameData> {
 const configured=options.inputFormat?{sampleRate:options.inputFormat.sampleRate,channels:options.inputFormat.channels,channelLayout:options.inputFormat.channelLayout,sampleFormat:options.inputFormat.sampleFormat,pts:options.inputFormat.pts?{value:options.inputFormat.pts.value,timeBase:{...options.inputFormat.pts.timeBase}}:null}:undefined;
 if(configured){
  rate(configured.sampleRate);const current=sampleFormat(configured.sampleFormat);
  if(!Number.isSafeInteger(configured.channels)||configured.channels<1||!Number.isSafeInteger(configured.channels*widths[current])||typeof configured.channelLayout!=='string')throw new RangeError('Invalid configured FLAC filter format');
  if(configured.pts){const {value,timeBase:{num,den}}=configured.pts;if(typeof value!=='bigint'||typeof num!=='bigint'||typeof den!=='bigint'||num<=0n||den<=0n||value*num*BigInt(configured.sampleRate)%den!==0n)throw new RangeError('Invalid configured FLAC filter timestamp');}
 }
 const {resources,signal}=options,maxFrameBytes=Math.min(options.maxFrameBytes,resources.budget.maxBufferBytes);
 if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1)throw new RangeError('Invalid FLAC filter allocation limit');
 // Either the execution or the Core context can cancel this stream.
 const controller=new AbortController(),abort=()=>controller.abort(signal.aborted?signal.reason:resources.signal.reason);
 signal.addEventListener('abort',abort,{once:true});resources.signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted||resources.signal.aborted)abort();
 const active=controller.signal;
 let release:(()=>void)|undefined,source:AsyncIterator<AudioFrameData>|undefined,closed=false;
 let channels:number|undefined,format:AudioSampleFormat|undefined,inputRate:number|undefined,layout:string|undefined;
 const closeSource=()=>{
  if(closed||!source)return Promise.resolve();closed=true;
  try{return Promise.resolve(source.return?.()).then(()=>{},()=>{});}catch{return Promise.resolve();}
 };
 const check=(frame:AudioFrameData)=>{
  active.throwIfAborted();
  const current=sampleFormat(frame.sampleFormat),planar=current.endsWith('p'),bytes=frame.samples*frame.channels*widths[current];
  rate(frame.sampleRate);
  if(!Number.isSafeInteger(frame.channels)||frame.channels<1||!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(bytes)||bytes>maxFrameBytes||frame.planes.length!==(planar?frame.channels:1))throw new RangeError('Invalid or oversized FLAC filter frame');
  for(const plane of frame.planes)if(!(plane instanceof Uint8Array)||plane.byteLength!==frame.samples*(planar?1:frame.channels)*widths[current])throw new RangeError('Invalid FLAC filter planes');
  if(channels!==undefined){if(channels!==frame.channels||format!==current||inputRate!==frame.sampleRate||layout!==frame.channelLayout)throw new RangeError('Changing FLAC filter input format');return;}
  channels=frame.channels;format=current;inputRate=frame.sampleRate;layout=frame.channelLayout;
  reserve(frame);
 };
 const reserve=(initial:AudioPadFormat)=>{
  // Scalar stages can retain their input while their output is suspended at a
  // downstream yield. Reserve each allocation, not just the largest one. FIFO
  // stages get two slots (partial buffer plus output); padding gets one slot.
  // maxFrameBytes bounds every scalar allocation even for wider intermediates.
  let resident=0,stageRate=initial.sampleRate;
  const widest=Math.max(widths[sampleFormat(initial.sampleFormat)],compiled.maxBytesPerSample);
  for(const step of compiled.steps){
   if(step.name==='volume'||step.name==='aformat'&&step.sampleFormat!==null)resident+=maxFrameBytes;
   else if(step.name==='asetnsamples'||step.name==='apad'){
    let samples=step.name==='asetnsamples'?step.samples:step.packetSamples;
    if(step.name==='apad'){
     // padAudio allocates only the remaining finite tail, not packetSamples
     // unconditionally. Keep the reservation and allocation bound consistent.
     const duration=step.padDuration??step.wholeDuration;
     const limit=step.padSamples??step.wholeSamples??(duration===null?null:(duration*BigInt(stageRate)+500000n)/1000000n);
     if(limit!==null&&limit<BigInt(samples))samples=Number(limit);
    }
    const bytes=samples*initial.channels*widest;
    if(!Number.isSafeInteger(bytes)||bytes>maxFrameBytes)throw new RangeError('FLAC filter buffer exceeds allocation limit');
    resident+=bytes*(step.name==='asetnsamples'?2:1);
   }
   if(step.name==='asetrate')stageRate=step.sampleRate;
   if(!Number.isSafeInteger(resident))throw new RangeError('FLAC filter resident envelope overflow');
  }
  release=resources.reserveExternalMemory(resident);
 };
 const input:AsyncIterable<AudioFrameData>={async *[Symbol.asyncIterator](){
  active.throwIfAborted();source=frames[Symbol.asyncIterator]();
  try{for(;;){active.throwIfAborted();const item=await wait(Promise.resolve(source.next()),active);if(item.done)return;check(item.value);yield item.value;}}
  finally{await wait(closeSource(),active);}
 }};
 try{
  active.throwIfAborted();
  if(configured){channels=configured.channels;format=sampleFormat(configured.sampleFormat);inputRate=configured.sampleRate;layout=configured.channelLayout;reserve(configured);}
  for await(const frame of compiled.process(input,{maxFrameBytes,signal:active,...(configured?{inputFormat:configured}:{})})){active.throwIfAborted();yield frame;}
 }finally{
  // Source cleanup may finish late; it owns its own input memory. No filtering
  // continues after the abort-aware input iterator rejects.
  try{await wait(closeSource(),active);}finally{release?.();signal.removeEventListener('abort',abort);resources.signal.removeEventListener('abort',abort);}
 }
}
