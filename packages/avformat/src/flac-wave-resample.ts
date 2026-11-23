import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {ResourceContext} from '@edge-ffmpeg/core';
import {AudioConversionError,convertAudioFrame,planAudioResample,resampleAudio,resampleInternalFormat,resampledSampleCount} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';

export interface FlacAudioResampleOptions {
 readonly resources:ResourceContext;
 readonly signal:AbortSignal;
 readonly maxFrameBytes:number;
 /** Downstream format width used to keep each emitted sample chunk bounded. */
 readonly maxBytesPerSample?:number;
}
const widths:Readonly<Record<AudioSampleFormat,number>>={u8:1,s16:2,s32:4,flt:4,dbl:8,u8p:1,s16p:2,s32p:4,fltp:4,dblp:8};
function format(value:string):AudioSampleFormat {
 if(!Object.hasOwn(widths,value))throw new AudioConversionError('Unsupported FLAC resampling sample format');
 return value as AudioSampleFormat;
}
function rate(value:number):void {
 if(!Number.isInteger(value)||value<1||value>2147483647)throw new AudioConversionError('Invalid FLAC resampling rate');
}
/** Exact finite default-FIR count, including short-input and retained-tail draining. */
export function countResampledFlacSamples(samples:bigint,inputRate:number,outputRate:number):bigint {
 return resampledSampleCount(samples,inputRate,outputRate);
}
/** Always observe late fulfillment/rejection, even when cancellation detaches the caller. */
function wait<T>(pending:PromiseLike<T>,signal:AbortSignal):Promise<T> {
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  void Promise.resolve(pending).then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});
  if(signal.aborted)abort();
 });
}
/**
 * One-shot, sequential borrowed-frame stream; no prefetch or publication.
 * Source storage stays producer-owned until its next()/return() settles. Output
 * planes are independently allocated, but their Core lease ends at the next
 * next()/return()/throw()/abort. Retaining consumers must copy/account separately
 * and must settle asynchronous writes before advancing this iterator.
 *
 * The real resident reservation covers the existing FIR coefficient/history
 * plan plus three bounded payload slots: converted input, FIR output (including
 * its partially filled buffer), and negotiated output. It excludes producer
 * storage, runtime/GC overhead and consumer copies. Cleanup retains this envelope
 * until the processing iterator AND upstream return have actually settled.
 */
export function resampleFlacAudio(frames:AsyncIterable<AudioFrameData>,outputRate:number,targetFormat:AudioSampleFormat,options:FlacAudioResampleOptions):AsyncIterable<AudioFrameData> {
 rate(outputRate);format(targetFormat);
 const downstreamWidth=options.maxBytesPerSample??1;
 if(!Number.isInteger(downstreamWidth)||downstreamWidth<1||downstreamWidth>8)throw new AudioConversionError('Invalid downstream resampling sample width');
 if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1)throw new AudioConversionError('Invalid FLAC resampling frame limit');
 const {resources}=options,maxFrameBytes=Math.min(options.maxFrameBytes,resources.budget.maxBufferBytes);
 let acquired=false;
 return {[Symbol.asyncIterator]():AsyncIterableIterator<AudioFrameData>{
  if(acquired)throw new AudioConversionError('FLAC resampling is one-shot');acquired=true;
  const controller=new AbortController(),signal=controller.signal,returned=Symbol('resampling returned');
  let source:AsyncIterator<AudioFrameData>|undefined,closing:Promise<void>|undefined,sourcePending:Promise<IteratorResult<AudioFrameData>>|undefined;
  let done=false,busy=false,sourceDone=false;
  const detach=()=>{options.signal.removeEventListener('abort',abort);resources.signal.removeEventListener('abort',resourceAbort);};
  const nextSource=():Promise<IteratorResult<AudioFrameData>>=>{
   const pending=Promise.resolve().then(()=>source!.next());sourcePending=pending;
   void pending.catch(()=>{});return pending;
  };
  const closeSource=():Promise<void>=>{
   if(!closing){closing=Promise.resolve().then(async()=>{
    // return() may settle before an already running next(). Keep the lease
    // until both settle, while still starting cleanup without waiting on next.
    const pending=sourcePending,cleanup=Promise.resolve().then(async()=>{if(!sourceDone)await source?.return?.();});
    const results=await Promise.allSettled([pending,cleanup]);
    const result=results[1]!;if(result.status==='rejected')throw result.reason;
   });void closing.catch(()=>{});}
   return closing;
  };
  const stop=(reason:unknown)=>{
   if(!signal.aborted)controller.abort(reason);
   void closeSource();
   // Async-generator return is queued behind any outstanding next. Both paths
   // observe rejections; the public iterator need not wait for a stuck provider.
   void engine.return().catch(()=>{});
  };
  const abort=()=>stop(options.signal.reason),resourceAbort=()=>stop(resources.signal.reason);
  async function* process():AsyncGenerator<AudioFrameData,void,unknown>{
   let release:(()=>void)|undefined,failed=false;
   try{
    signal.throwIfAborted();source=frames[Symbol.asyncIterator]();
    const first=await wait(nextSource(),signal);
    if(first.done){sourceDone=true;return;}
    const initial=first.value,sourceFormat=format(initial.sampleFormat);
    rate(initial.sampleRate);
    if(!Number.isSafeInteger(initial.channels)||initial.channels<1)throw new AudioConversionError('Invalid FLAC resampling channels');
    const changingRate=initial.sampleRate!==outputRate;
    const internal=changingRate?resampleInternalFormat(sourceFormat,targetFormat):targetFormat;
    const widest=Math.max(widths[sourceFormat],widths[internal],widths[targetFormat],downstreamWidth);
    const capacity=Math.floor(maxFrameBytes/(initial.channels*widest));
    if(capacity<1)throw new AudioConversionError('FLAC resampling sample exceeds frame limit');
    const internalLimit=capacity*initial.channels*widths[internal];
    const plan=changingRate?planAudioResample(initial.sampleRate,outputRate,initial.channels,{maxFrameBytes:internalLimit,maxStateBytes:resources.budget.maxResidentBytes,sampleFormat:internal as 's16'|'flt'|'dbl'}):undefined;
    const resident=(plan?.stateBytes??0)+3*maxFrameBytes;
    if(!Number.isSafeInteger(resident))throw new AudioConversionError('FLAC resampling reservation overflow');
    release=resources.reserveExternalMemory(resident);
    let received=0n;
    const origin=initial.pts===null?null:position(initial);
    function position(frame:AudioFrameData):bigint|null {
     if(frame.pts===null)return null;
     const {value,timeBase:{num,den}}=frame.pts,numerator=value*num*BigInt(frame.sampleRate);
     if(num<=0n||den<=0n||numerator%den!==0n)throw new AudioConversionError('Resampling requires sample-aligned timestamps');
     return numerator/den;
    }
    async function* input():AsyncGenerator<AudioFrameData,void,unknown>{
     let item:IteratorResult<AudioFrameData>=first;
     for(;;){
      if(item.done){sourceDone=true;return;}
      signal.throwIfAborted();const frame=item.value,current=format(frame.sampleFormat);
      const bytes=frame.samples*frame.channels*widths[current],planar=current.endsWith('p');
      if(frame.sampleRate!==initial.sampleRate||frame.channels!==initial.channels||frame.channelLayout!==initial.channelLayout||current!==sourceFormat||!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(bytes)||bytes>maxFrameBytes||!Array.isArray(frame.planes)||frame.planes.length!==(planar?frame.channels:1))throw new AudioConversionError('Invalid or changing FLAC resampling frame');
      const stride=(planar?1:frame.channels)*widths[current];
      for(const plane of frame.planes)if(!(plane instanceof Uint8Array)||plane.byteLength!==frame.samples*stride)throw new AudioConversionError('Invalid FLAC resampling planes');
      const pts=position(frame);
      if(origin===null?pts!==null:pts!==origin+received)throw new AudioConversionError('Resampling requires contiguous timestamps');
      for(let offset=0;offset<frame.samples;offset+=capacity){
       signal.throwIfAborted();const samples=Math.min(capacity,frame.samples-offset);
       const slice:AudioFrameData={...frame,samples,planes:frame.planes.map(plane=>plane.subarray(offset*stride,(offset+samples)*stride)),pts:pts===null?null:{value:pts+BigInt(offset),timeBase:{num:1n,den:BigInt(frame.sampleRate)}}};
       yield convertAudioFrame(slice,internal,{maxFrameBytes,signal});
      }
      received+=BigInt(frame.samples);
      item=await wait(nextSource(),signal);
     }
    }
    const converted=input();
    const sampled=changingRate?resampleAudio(converted,outputRate,{maxFrameBytes:internalLimit,maxStateBytes:Math.max(1,plan!.stateBytes),sampleFormat:internal as 's16'|'flt'|'dbl',signal}):converted;
    // Only normal upstream EOF drains FIR history. return/error/abort unwind it.
    for await(const frame of sampled){signal.throwIfAborted();yield frame.sampleFormat===targetFormat?frame:convertAudioFrame(frame,targetFormat,{maxFrameBytes,signal});}
   }catch(error){failed=true;throw error;}
   finally{
    try{await closeSource();}catch(error){if(!failed&&!signal.aborted)throw error;}
    finally{release?.();detach();}
   }
  }
  const engine=process();
  options.signal.addEventListener('abort',abort,{once:true});resources.signal.addEventListener('abort',resourceAbort,{once:true});
  if(options.signal.aborted)abort();else if(resources.signal.aborted)resourceAbort();
  return {
   [Symbol.asyncIterator](){return this;},
   async next():Promise<IteratorResult<AudioFrameData>>{
    if(busy)throw new AudioConversionError('Concurrent FLAC resampling reads');
    if(signal.aborted){if(signal.reason===returned)return {done:true,value:undefined};throw signal.reason;}
    if(done)return {done:true,value:undefined};busy=true;
    try{const item=await wait(engine.next(),signal);if(item.done){done=true;detach();}return item;}
    catch(error){done=true;stop(error);if(signal.reason===returned)return {done:true,value:undefined};throw error;}
    finally{busy=false;}
   },
   async return():Promise<IteratorResult<AudioFrameData>>{done=true;stop(returned);detach();return {done:true,value:undefined};},
   async throw(error?:unknown):Promise<IteratorResult<AudioFrameData>>{done=true;stop(error);detach();throw error;}
  };
 }};
}
