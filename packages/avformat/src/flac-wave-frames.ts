import {ExecutionError} from '@edge-ffmpeg/core';
import type {ReadHandle,ResourceContext} from '@edge-ffmpeg/core';
import {createFlacDecoder} from '@edge-ffmpeg/avcodec';
import type {FlacDecoder,FlacDecoderMetadata,FlacDecodedFrame} from '@edge-ffmpeg/avcodec';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {openFlacDemux} from '@edge-ffmpeg/containers';

export interface FlacAudioFramesOptions {
 readonly resources:ResourceContext;
 readonly signal:AbortSignal;
 /** Maximum decoder planar frame bytes and maximum packed output chunk bytes. */
 readonly maxFrameBytes:number;
 readonly maxReadBytes?:number;
}
export interface FlacAudioFramesMetadata extends FlacDecoderMetadata {
 readonly channelLayout:string;
 readonly channelMask:bigint;
 readonly sampleFormat:'s16'|'s32';
 readonly timeBase:Readonly<{num:bigint;den:bigint}>;
}
export interface FlacAudioFrames extends AsyncIterableIterator<AudioFrameData> {
 /** Parse metadata and initialize one decoder, without pulling any PCM frame. */
 prepare():Promise<FlacAudioFramesMetadata>;
 readonly metadata:FlacAudioFramesMetadata|null;
 /** Idempotent; also valid before prepare/next or during a pending read. */
 close():Promise<void>;
}
const invalid=(message:string):never=>{throw new ExecutionError('invalid-arguments',message);};

/**
 * One-shot, demand-driven public-decoder bridge. prepare() exposes header data
 * without consuming a PCM frame; decodeFlacAudioFrames itself performs no reads.
 * Packed little-endian planes are borrowed until next/return/throw/close/abort.
 * Retaining consumers must make their own Core-accounted copy before advancing.
 * The decoder's borrowed planar frame is never exposed and is released before
 * advancing the decoder, or on any exit. Chunking may split decoder boundaries.
 * No outputs are opened: the backend must publish through its atomic output group.
 */
export function decodeFlacAudioFrames(module:WebAssembly.Module,input:ReadHandle,options:FlacAudioFramesOptions):FlacAudioFrames{
 const {resources,signal,maxFrameBytes,maxReadBytes=65536}=options;
 if(!(module instanceof WebAssembly.Module))invalid('FLAC decoding requires a trusted precompiled module');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||maxFrameBytes>0xffffffff||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||maxReadBytes>1048576)invalid('Invalid FLAC audio frame bounds');
 const size=input.size,readAt=input.readAt.bind(input);
 if(typeof size!=='bigint'||size<0n||size>0x7fffffffffffffffn)invalid('Invalid FLAC audio input size');
 const readBound=Math.min(maxReadBytes,65536,resources.budget.maxBufferBytes);
 const chunkBound=Math.min(maxFrameBytes,resources.budget.maxBufferBytes);
 const controller=new AbortController(),active=controller.signal,returned=Symbol('FLAC audio frames returned');
 let info:FlacAudioFramesMetadata|null=null,preparing:Promise<FlacAudioFramesMetadata>|undefined;
 let decoder:FlacDecoder|undefined,opening:Promise<FlacDecoder>|undefined,closing:Promise<void>|undefined;
 let held:FlacDecodedFrame|undefined,at=0,position=0n,busy=false,closed=false;
 let releasePacked:(()=>void)|undefined,releaseRead:(()=>void)|undefined;
 const releaseOutput=()=>{releasePacked?.();releasePacked=undefined;};
 const releaseFrame=()=>{held?.release();held=undefined;at=0;};
 const detach=()=>{signal.removeEventListener('abort',abort);resources.signal.removeEventListener('abort',resourceAbort);};
 function wait<T>(pending:PromiseLike<T>):Promise<T>{
  return new Promise((resolve,reject)=>{
   const cancel=()=>{active.removeEventListener('abort',cancel);reject(active.reason);};
   active.addEventListener('abort',cancel,{once:true});
   void Promise.resolve(pending).then(value=>{active.removeEventListener('abort',cancel);if(active.aborted)reject(active.reason);else resolve(value);},error=>{active.removeEventListener('abort',cancel);reject(active.aborted?active.reason:error);});
   if(active.aborted)cancel();
  });
 }
 function cleanup():Promise<void>{
  if(!closing){
   closing=Promise.resolve().then(async()=>{
    try{const value=decoder??await opening;await value?.close();}
    finally{releaseRead?.();releaseRead=undefined;}
   });
   void closing.catch(()=>{});
  }
  return closing;
 }
 function stop(reason:unknown):Promise<void>{
  if(!closed){closed=true;releaseOutput();releaseFrame();detach();controller.abort(reason);}
  return cleanup();
 }
 const abort=()=>{void stop(signal.reason).catch(()=>{});};
 const resourceAbort=()=>{void stop(resources.signal.reason).catch(()=>{});};
 signal.addEventListener('abort',abort,{once:true});resources.signal.addEventListener('abort',resourceAbort,{once:true});
 if(signal.aborted)abort();else if(resources.signal.aborted)resourceAbort();
 const reader:ReadHandle=Object.freeze({size,readAt});
 async function initialize():Promise<FlacAudioFramesMetadata>{
  active.throwIfAborted();
  // Metadata parsing uses bounded Core allocations and does not iterate packets.
  // It preserves FLAC-specific layouts and WAVEFORMATEXTENSIBLE_CHANNEL_MASK.
  const demuxOpening=openFlacDemux(reader,{resources,signal:active,maxReadBytes:readBound,maxScanBytes:size,maxPacketBytes:size,maxMetadataBytes:BigInt(resources.budget.maxResidentBytes),maxPictureBytes:Math.min(1048576,resources.budget.maxBufferBytes),maxPendingPackets:Math.min(4096,resources.budget.maxPendingPackets)});
  void demuxOpening.then(value=>{if(active.aborted)void value.close().catch(()=>{});},()=>{});
  const demux=await wait(demuxOpening);
  let layout:string,mask:bigint,expected:{channels:number;sampleRate:number;bitsPerSample:number;totalSamples:bigint};
  try{
   const metadata=demux.metadata;
   if(metadata.kind!=='flac-streaminfo'||!metadata.streamInfo||!metadata.channelLayout)throw new ExecutionError('unsupported-command','FLAC audio frames require STREAMINFO');
   layout=metadata.channelLayout.name;mask=metadata.channelLayout.mask;expected=metadata.streamInfo;
  }finally{await demux.close();}
  active.throwIfAborted();
  // The host provider's bounded read result is borrowed; reserve its maximum
  // live span in addition to the decoder's own fixed 16 MiB reservation.
  releaseRead=resources.reserveExternalMemory(readBound);
  opening=createFlacDecoder(module,reader,{signal:active,maxReadBytes:readBound,maxFrameBytes,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  decoder=await wait(opening);
  const initial=await wait(decoder.next());
  if(initial.status!=='metadata'){
   if(initial.status==='frame')initial.release();
   throw new Error('FLAC decoder did not initialize metadata');
  }
  const value=initial.metadata;
  if(value.channels!==expected.channels||value.sampleRate!==expected.sampleRate||value.bitsPerSample!==expected.bitsPerSample||value.totalSamples!==expected.totalSamples)throw new Error('FLAC metadata changed while opening decoder');
  const width=value.bitsPerSample<=16?2:4;
  if(chunkBound<value.channels*width)throw new ExecutionError('resource-budget','FLAC packed sample exceeds buffer budget');
  info=Object.freeze({...value,channelLayout:layout,channelMask:mask,sampleFormat:width===2?'s16':'s32',timeBase:Object.freeze({num:1n,den:BigInt(value.sampleRate)})});
  return info;
 }
 function prepare():Promise<FlacAudioFramesMetadata>{
  if(active.aborted)return Promise.reject(active.reason);
  if(closed)return Promise.reject(new Error('FLAC audio frames are closed'));
  if(!preparing){preparing=initialize().catch(async error=>{await stop(error);throw error;});void preparing.catch(()=>{});}
  return preparing;
 }
 const stream:FlacAudioFrames={
  [Symbol.asyncIterator](){return this;},
  get metadata(){return info;},prepare,
  async next():Promise<IteratorResult<AudioFrameData>>{
   if(busy)invalid('Concurrent FLAC audio frame reads');
   if(active.aborted){if(active.reason===returned)return {done:true,value:undefined};throw active.reason;}
   if(closed)return {done:true,value:undefined};
   busy=true;releaseOutput();
   try{
    const metadata=await prepare(),width=metadata.sampleFormat==='s16'?2:4;
    if(held&&at===held.samples)releaseFrame();
    while(!held){
     const item=await wait(decoder!.next());
     active.throwIfAborted();
     if(item.metadata.channels!==metadata.channels||item.metadata.sampleRate!==metadata.sampleRate||item.metadata.bitsPerSample!==metadata.bitsPerSample||item.metadata.totalSamples!==metadata.totalSamples){if(item.status==='frame')item.release();throw new Error('Changing FLAC audio parameters');}
     if(item.status==='metadata')continue;
     if(item.status==='end'){
      if(metadata.totalSamples!==0n&&position!==metadata.totalSamples)throw new Error('FLAC sample count mismatch');
      await stop(returned);return {done:true,value:undefined};
     }
     if(item.status!=='frame')throw new Error('Unexpected FLAC decoder result');
     held=item;
     if(item.samplePosition!==position)throw new Error('Noncontiguous FLAC sample positions');
    }
    const samples=Math.min(held.samples-at,Math.floor(chunkBound/(metadata.channels*width)));
    const bytes=samples*metadata.channels*width;
    releasePacked=resources.reserveExternalMemory(bytes);
    const data=new Uint8Array(bytes),view=new DataView(data.buffer),planes=held.planes,shift=width*8-metadata.bitsPerSample;
    for(let sample=0;sample<samples;sample++){
     if((sample&1023)===0)active.throwIfAborted();
     for(let channel=0;channel<metadata.channels;channel++){
      const value=planes[channel]![at+sample]!<<shift,index=(sample*metadata.channels+channel)*width;
      if(width===2)view.setInt16(index,value,true);else view.setInt32(index,value,true);
     }
    }
    const pts={value:position,timeBase:metadata.timeBase};
    at+=samples;position+=BigInt(samples);
    if(at===held.samples)releaseFrame();
    return {done:false,value:{sampleRate:metadata.sampleRate,channels:metadata.channels,channelLayout:metadata.channelLayout,sampleFormat:metadata.sampleFormat,samples,planes:[data],pts}};
   }catch(error){const returning=active.aborted&&active.reason===returned;await stop(error);if(returning)return {done:true,value:undefined};throw error;}
   finally{busy=false;}
  },
  async return():Promise<IteratorResult<AudioFrameData>>{await stop(returned);return {done:true,value:undefined};},
  async throw(error?:unknown):Promise<IteratorResult<AudioFrameData>>{await stop(error);throw error;},
  async close(){await stop(returned);}
 };
 return stream;
}

/** Open metadata eagerly, but leave every decoded PCM sample for the iterator. */
export async function prepareFlacAudioFrames(module:WebAssembly.Module,reader:ReadHandle,options:FlacAudioFramesOptions):Promise<FlacAudioFrames>{
 const frames=decodeFlacAudioFrames(module,reader,options);
 await frames.prepare();return frames;
}
