import {ExecutionError} from '@edge-ffmpeg/core';
import type {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';

export interface FlacAudioTrimRange {
 readonly startSample:bigint;
 readonly endSampleExclusive:bigint|null;
 readonly outputPtsSamples:bigint;
}
export interface FlacAudioTrimOptions {
 readonly resources:ResourceContext;
 readonly signal:AbortSignal;
 readonly maxFrameBytes:number;
}
const widths:Readonly<Record<string,number>>={u8:1,s16:2,s32:4,flt:4,dbl:8};
const invalid=(message:string):never=>{throw new ExecutionError('invalid-arguments',message);};
function validateRange(range:FlacAudioTrimRange):void{
 if(typeof range.startSample!=='bigint'||range.startSample<0n||typeof range.outputPtsSamples!=='bigint'||range.endSampleExclusive!==null&&(typeof range.endSampleExclusive!=='bigint'||range.endSampleExclusive<range.startSample))invalid('Invalid FLAC audio trim range');
}
/** Count the intersection with a known decoded stream length, without reading PCM. */
export function countTrimmedFlacSamples(totalSamples:bigint,range:FlacAudioTrimRange):bigint{
 validateRange(range);
 if(typeof totalSamples!=='bigint'||totalSamples<0n)invalid('Invalid FLAC audio sample count');
 const end=range.endSampleExclusive===null||range.endSampleExclusive>totalSamples?totalSamples:range.endSampleExclusive;
 return end>range.startSample?end-range.startSample:0n;
}
/**
 * Trim by decoded sample ordinal (not input PTS), then generate contiguous PTS
 * in 1/sampleRate units. All existing packed/planar audio formats are byte-copied.
 * One output allocation is reserved through Core before allocation. Its planes
 * are borrowed until the next next(), return(), throw(), or abort; consumers
 * retaining them beyond that boundary must make their own accounted copy.
 * Input frames remain producer-owned and are never mutated or retained after
 * advancing/closing their iterator. The source must release borrowed frames in
 * next()/return(); AudioFrameData itself has no release method.
 */
export function trimFlacAudio(frames:AsyncIterable<AudioFrameData>,range:FlacAudioTrimRange,options:FlacAudioTrimOptions):AsyncIterable<AudioFrameData>{
 validateRange(range);
 const {startSample,endSampleExclusive,outputPtsSamples}=range;
 const {resources,signal,maxFrameBytes}=options;
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid FLAC audio trim frame limit');
 let acquired=false;
 return {[Symbol.asyncIterator]():AsyncIterableIterator<AudioFrameData>{
  if(acquired)invalid('FLAC audio trim is one-shot');acquired=true;
  const controller=new AbortController(),active=controller.signal,returned=Symbol('trim returned');
  let source:AsyncIterator<AudioFrameData>|undefined,closing:Promise<void>|undefined;
  let closed=false,busy=false,position=0n,emitted=0n,release:(()=>void)|undefined;
  let format:{sampleRate:number;channels:number;channelLayout:string;sampleFormat:string}|undefined;
  const releaseOutput=()=>{release?.();release=undefined;};
  const detach=()=>{signal.removeEventListener('abort',abort);resources.signal.removeEventListener('abort',resourceAbort);};
  const closeSource=():Promise<void>=>{
   if(!closing){closing=Promise.resolve().then(async()=>{await source?.return?.();});void closing.catch(()=>{});}
   return closing;
  };
  const stop=(reason:unknown)=>{closed=true;releaseOutput();detach();if(!active.aborted)controller.abort(reason);void closeSource();};
  const abort=()=>stop(signal.reason),resourceAbort=()=>stop(resources.signal.reason);
  function wait<T>(pending:PromiseLike<T>,cancellation:AbortSignal=active):Promise<T>{
   return new Promise((resolve,reject)=>{
    const cancel=()=>{cancellation.removeEventListener('abort',cancel);reject(cancellation.reason);};
    cancellation.addEventListener('abort',cancel,{once:true});
    void Promise.resolve(pending).then(value=>{cancellation.removeEventListener('abort',cancel);if(cancellation.aborted)reject(cancellation.reason);else resolve(value);},error=>{cancellation.removeEventListener('abort',cancel);reject(cancellation.aborted?cancellation.reason:error);});
    if(cancellation.aborted)cancel();
   });
  }
  signal.addEventListener('abort',abort,{once:true});
  resources.signal.addEventListener('abort',resourceAbort,{once:true});
  if(signal.aborted)abort();else if(resources.signal.aborted)resourceAbort();
  const iterator:AsyncIterableIterator<AudioFrameData>={
   [Symbol.asyncIterator](){return this;},
   async next():Promise<IteratorResult<AudioFrameData>>{
    if(busy)throw new ExecutionError('invalid-arguments','Concurrent FLAC audio trim reads');
    if(active.aborted){if(active.reason===returned)return {done:true,value:undefined};throw active.reason;}
    if(closed)return {done:true,value:undefined};
    busy=true;releaseOutput();
    try{
     if(endSampleExclusive!==null&&(startSample===endSampleExclusive||position>=endSampleExclusive)){closed=true;await wait(closeSource());detach();return {done:true,value:undefined};}
     source??=frames[Symbol.asyncIterator]();
     for(;;){
      active.throwIfAborted();
      const item=await wait(Promise.resolve(source.next()));
      if(item.done){closed=true;detach();return {done:true,value:undefined};}
      const frame=item.value;
      const planar=typeof frame.sampleFormat==='string'&&frame.sampleFormat.endsWith('p');
      const base=planar?frame.sampleFormat.slice(0,-1):frame.sampleFormat;
      const width=Object.hasOwn(widths,base)?widths[base]!:0;
      const size=frame.samples*frame.channels*width;
      if(!width||!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(frame.channels)||frame.channels<1||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<1||typeof frame.channelLayout!=='string'||!Number.isSafeInteger(size)||size>maxFrameBytes||!Array.isArray(frame.planes)||frame.planes.length!==(planar?frame.channels:1))invalid('Invalid FLAC audio trim frame');
      const stride=width*(planar?1:frame.channels),planeBytes=frame.samples*stride;
      for(const plane of frame.planes)if(!(plane instanceof Uint8Array)||plane.byteLength!==planeBytes)invalid('Invalid FLAC audio trim plane');
      if(format&&(frame.sampleRate!==format.sampleRate||frame.channels!==format.channels||frame.channelLayout!==format.channelLayout||frame.sampleFormat!==format.sampleFormat))invalid('FLAC audio trim requires a stable audio format');
      format??={sampleRate:frame.sampleRate,channels:frame.channels,channelLayout:frame.channelLayout,sampleFormat:frame.sampleFormat};
      const frameStart=position,frameEnd=position+BigInt(frame.samples);
      position=frameEnd;
      const first=startSample>frameStart?startSample:frameStart;
      const last=endSampleExclusive!==null&&endSampleExclusive<frameEnd?endSampleExclusive:frameEnd;
      if(last<=first)continue;
      const offset=Number(first-frameStart),samples=Number(last-first),bytes=samples*frame.channels*width;
      if(bytes>resources.budget.maxBufferBytes)throw new ExecutionError('resource-budget','Trimmed FLAC audio frame exceeds buffer budget');
      release=resources.reserveExternalMemory(bytes);
      const data=new Uint8Array(bytes),planes:Uint8Array[]=[];
      for(let channel=0;channel<frame.planes.length;channel++){
       active.throwIfAborted();
       const plane=data.subarray(channel*samples*stride,(channel+1)*samples*stride);
       plane.set(frame.planes[channel]!.subarray(offset*stride,(offset+samples)*stride));planes.push(plane);
      }
      const pts={value:outputPtsSamples+emitted,timeBase:{num:1n,den:BigInt(format.sampleRate)}};
      emitted+=BigInt(samples);
      return {done:false,value:{...format,samples,planes,pts}};
     }
    }catch(error){
     const returning=active.aborted&&active.reason===returned;
     stop(error);
     // A non-cooperative source return may never settle. Cancellation detaches,
     // but closeSource always observes late fulfillment/rejection.
     if(returning)return {done:true,value:undefined};throw error;
    }finally{busy=false;}
   },
   async return():Promise<IteratorResult<AudioFrameData>>{
    const wasClosed=closed,wasBusy=busy;
    stop(returned);
    if(!wasClosed&&!wasBusy&&!signal.aborted&&!resources.signal.aborted){
     // Surface normal cleanup failure, but never trap an abort behind it.
     const cleanup=new AbortController(),cancel=()=>cleanup.abort(signal.aborted?signal.reason:resources.signal.reason);
     signal.addEventListener('abort',cancel,{once:true});resources.signal.addEventListener('abort',cancel,{once:true});
     if(signal.aborted||resources.signal.aborted)cancel();
     try{await wait(closeSource(),cleanup.signal);}finally{signal.removeEventListener('abort',cancel);resources.signal.removeEventListener('abort',cancel);}
    }
    return {done:true,value:undefined};
   },
   async throw(error?:unknown):Promise<IteratorResult<AudioFrameData>>{stop(error);throw error;}
  };
  return iterator;
 }};
}
