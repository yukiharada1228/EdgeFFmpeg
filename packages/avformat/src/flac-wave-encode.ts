import {ExecutionError} from '@edge-ffmpeg/core';
import type {ResourceContext} from '@edge-ffmpeg/core';
import {encodePcm,getPcmFormat} from '@edge-ffmpeg/avcodec';
import type {AudioFrameData,MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';

export interface FlacAudioEncodeOptions {
 readonly resources:ResourceContext;
 readonly signal:AbortSignal;
 readonly maxFrameBytes:number;
 readonly frameLimit:bigint|null;
}
export interface FlacAudioCount {
 readonly samples:bigint;
 readonly frames:bigint;
 readonly audio:Readonly<{sampleRate:number;channels:number;channelLayout:string;sampleFormat:string}>|null;
}
/** A sequential finite-header prepass. Retains scalar metadata only; the caller
 * must close this decoder before opening the second pass. */
export async function countFlacAudio(frames:AsyncIterable<AudioFrameData>,signal:AbortSignal,frameLimit:bigint|null=null):Promise<FlacAudioCount>{
 if(frameLimit!==null&&(typeof frameLimit!=='bigint'||frameLimit<0n))throw new ExecutionError('invalid-arguments','Invalid FLAC output frame limit');
 signal.throwIfAborted();
 let samples=0n,count=0n,audio:FlacAudioCount['audio']=null;
 if(frameLimit!==0n)for await(const frame of frames){
  signal.throwIfAborted();
  if(!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<1||!Number.isSafeInteger(frame.channels)||frame.channels<1)throw new ExecutionError('invalid-arguments','Invalid FLAC counting frame');
  if(audio&&(audio.sampleRate!==frame.sampleRate||audio.channels!==frame.channels||audio.channelLayout!==frame.channelLayout||audio.sampleFormat!==frame.sampleFormat))throw new ExecutionError('unsupported-command','Changing FLAC output format');
  audio??=Object.freeze({sampleRate:frame.sampleRate,channels:frame.channels,channelLayout:frame.channelLayout,sampleFormat:frame.sampleFormat});
  samples+=BigInt(frame.samples);count++;
  if(frameLimit!==null&&count>=frameLimit)break;
 }
 return Object.freeze({samples,frames:count,audio});
}
/** Preserve transformed frame boundaries and retain real encoding allocations
 * across each borrowed packet yield. The consumer must close on early exit. */
export async function* encodeFlacAudio(frames:AsyncIterable<AudioFrameData>,codec:PcmCodec,options:FlacAudioEncodeOptions):AsyncIterable<MediaPacket>{
 const {resources,signal,frameLimit}=options;
 if(frameLimit!==null&&(typeof frameLimit!=='bigint'||frameLimit<0n))throw new ExecutionError('invalid-arguments','Invalid FLAC output frame limit');
 if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1)throw new ExecutionError('invalid-arguments','Invalid FLAC PCM allocation limit');
 signal.throwIfAborted();resources.signal.throwIfAborted();
 if(frameLimit===0n)return;
 const format=getPcmFormat(codec),maxFrameBytes=Math.min(options.maxFrameBytes,resources.budget.maxBufferBytes);
 let count=0n;
 for await(const frame of frames){
  signal.throwIfAborted();resources.signal.throwIfAborted();
  const values=frame.samples*frame.channels,outputBytes=values*format.bytesPerSample;
  const conversionBytes=frame.sampleFormat===format.sampleFormat?0:values*format.frameBytesPerSample;
  if(!Number.isSafeInteger(outputBytes)||!Number.isSafeInteger(conversionBytes)||outputBytes<1||outputBytes>maxFrameBytes||conversionBytes>maxFrameBytes)throw new ExecutionError('resource-budget','FLAC encoded PCM frame exceeds allocation budget');
  const release=resources.reserveExternalMemory(outputBytes+conversionBytes);
  try{yield encodePcm(frame,codec,{maxFrameBytes,signal});}
  finally{release();}
  count++;
  if(frameLimit!==null&&count>=frameLimit)return;
 }
}
