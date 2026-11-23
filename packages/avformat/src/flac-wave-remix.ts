import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {ResourceContext} from '@edge-ffmpeg/core';
import {AudioConversionError,remixAudioFrame,remixInternalFormat} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat,RemixArithmetic} from '@edge-ffmpeg/swresample';

export interface FlacAudioRemixOptions {
 readonly resources:ResourceContext;
 readonly signal:AbortSignal;
 readonly maxFrameBytes:number;
 readonly arithmetic?:RemixArithmetic;
 readonly matrixSampleFormat?:AudioSampleFormat;
}

function sampleWidth(format:string):number{
 const base=format.endsWith('p')?format.slice(0,-1):format;
 switch(base){case 'u8':return 1;case 's16':return 2;case 's32':case 'flt':return 4;case 'dbl':return 8;default:throw new AudioConversionError('Unsupported remix sample format');}
}

/** The rejection handler remains attached after abort, including for iterator cleanup. */
function wait<T>(pending:PromiseLike<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  void Promise.resolve(pending).then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(signal.aborted?signal.reason:error);});
  if(signal.aborted)abort();
 });
}

/**
 * Bounded unchanged-rate mono/stereo remix. Input storage belongs to the producer.
 * Each yielded output owns its planes and is reserved until next()/return()/throw().
 * Consume it before advancing, or copy it under a separate caller reservation.
 * No prefetch, packet accumulation, I/O, or publication occurs in this helper.
 */
export async function* remixFlacAudio(frames:AsyncIterable<AudioFrameData>,channels:1|2,targetFormat:AudioSampleFormat,options:FlacAudioRemixOptions):AsyncGenerator<AudioFrameData,void,unknown>{
 const {resources}=options,signal=AbortSignal.any([options.signal,resources.signal]);
 const maxFrameBytes=Math.min(options.maxFrameBytes,resources.budget.maxBufferBytes),arithmetic=options.arithmetic??'separate';
 signal.throwIfAborted();
 if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1)throw new AudioConversionError('Invalid remix frame allocation limit');
 if(channels!==1&&channels!==2)throw new AudioConversionError('Remixing currently requires canonical mono/stereo layouts');
 if(arithmetic!=='separate'&&arithmetic!=='fused')throw new AudioConversionError('Unsupported remix arithmetic profile');
 const targetWidth=sampleWidth(targetFormat);
 const iterator=frames[Symbol.asyncIterator]();
 let complete=false,failed=false;
 try{
  for(;;){
   signal.throwIfAborted();
   const item=await wait(iterator.next(),signal);
   signal.throwIfAborted();
   if(item.done){complete=true;return;}
   const frame=item.value;
   if(frame.channels!==1&&frame.channels!==2)throw new AudioConversionError('Remixing currently requires canonical mono/stereo layouts');
   const layout=frame.channels===1?'mono':'stereo';
   if(![layout,'','unknown','unspecified',`${frame.channels} channels`].includes(frame.channelLayout))throw new AudioConversionError('Remixing currently requires canonical mono/stereo layouts');
   if(!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<1)throw new AudioConversionError('Invalid audio dimensions');
   const bounded=(width:number,count:number)=>{
    const bytes=frame.samples*count*width;
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>maxFrameBytes)throw new AudioConversionError('Remixed audio frame exceeds allocation limit');
    return bytes;
   };
   const sourceWidth=sampleWidth(frame.sampleFormat);
   bounded(sourceWidth,frame.channels);
   const planar=frame.sampleFormat.endsWith('p'),planeBytes=frame.samples*(planar?1:frame.channels)*sourceWidth;
   if(frame.planes.length!==(planar?frame.channels:1)||frame.planes.some(plane=>!(plane instanceof Uint8Array)||plane.byteLength!==planeBytes))throw new AudioConversionError('Invalid audio plane dimensions');
   const outputBytes=bounded(targetWidth,channels);
   let scratchBytes=0;
   if(channels!==frame.channels){
    const internal=remixInternalFormat(frame.sampleFormat as AudioSampleFormat,targetFormat),width=sampleWidth(internal);
    // remixAudioFrame first converts the source, then allocates the matrix result,
    // then (only if necessary) converts that result to the destination format.
    scratchBytes=bounded(width,frame.channels);
    const mixedBytes=bounded(width,channels),mixedFormat=`${internal}${targetFormat.endsWith('p')?'p':''}`;
    if(mixedFormat!==targetFormat)scratchBytes+=mixedBytes;
   }
   const releaseOutput=resources.reserveExternalMemory(outputBytes);
   try{
    const releaseScratch=resources.reserveExternalMemory(scratchBytes);
    let output:AudioFrameData;
    try{
     output=remixAudioFrame({...frame,channelLayout:layout},channels,targetFormat,{maxFrameBytes,signal,arithmetic,...(options.matrixSampleFormat?{matrixSampleFormat:options.matrixSampleFormat}:{})});
     signal.throwIfAborted();
    }finally{releaseScratch();}
    yield output;
   }finally{releaseOutput();}
  }
 }catch(error){failed=true;throw error;}
 finally{
  if(!complete&&iterator.return){
   // Do not let an uncooperative producer delay abort or mask the original error.
   try{await wait(iterator.return(),signal);}catch(error){if(!failed&&!signal.aborted)throw error;}
  }
 }
}
