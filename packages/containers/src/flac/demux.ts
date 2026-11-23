/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Scoped FFmpeg 9.0.2 946fcce07b6dcd0331c8cc609192aeff5e1924f8
 * flacdec.c/demux.c composition (Fabrice Bellard). Default sample timebase;
 * no seek, wrap, nofillin, igndts, or full AVIO scheduling equivalence.
 */
import {readFlacDemuxMetadata} from './metadata-context.js';
import type {FlacDemuxMetadataOptions} from './metadata-context.js';
import {openFlacPacketRanges} from './ranges.js';
import {readFlacPacketChunks} from './payload.js';
import {createFlacPacketTiming} from './timing.js';
import type {TimedFlacRange} from './timing.js';
import {waitForFlacAbort} from './abort-wait.js';
import type {FlacRangeSource,FlacRangeStreamOptions,FlacPacketChunk} from './types.js';
export interface FlacDemuxOptions extends FlacDemuxMetadataOptions,Omit<FlacRangeStreamOptions,'checkpoint'> {
 readonly maxPacketBytes:bigint;readonly maxPendingPackets?:number;
}
export async function openFlacDemux(input:FlacRangeSource,options:FlacDemuxOptions){
 // Capture caller-owned policy and capabilities before metadata can suspend.
 const policy=Object.freeze({...options}),{signal}=policy;signal.throwIfAborted();
 const {maxPacketBytes}=policy,maxPictureBytes=policy.maxPictureBytes??1048576;
 if(typeof maxPacketBytes!=='bigint'||maxPacketBytes<0n)throw new RangeError('Invalid FLAC packet byte limit');
 const allocator=policy.resources,allocate=allocator.allocate.bind(allocator),checkpoint=policy.checkpoint?.bind(options);
 const budget='budget' in allocator?allocator.budget:undefined;
 function budgetLimit(key:'maxBufferBytes'|'maxPendingPackets',fallback:number){
  if(budget===undefined)return fallback;
  if(typeof budget!=='object'||budget===null||!(key in budget))throw new RangeError('Invalid FLAC resource budget');
  const value=key==='maxBufferBytes'?('maxBufferBytes' in budget?budget.maxBufferBytes:undefined):('maxPendingPackets' in budget?budget.maxPendingPackets:undefined);
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new RangeError('Invalid FLAC resource budget');
  return value;
 }
 const readLimit=Math.min(policy.maxReadBytes??65536,budgetLimit('maxBufferBytes',65536));
 const pendingLimit=Math.min(policy.maxPendingPackets??128,budgetLimit('maxPendingPackets',128));
 if(!Number.isSafeInteger(readLimit)||readLimit<1||readLimit>65536)throw new RangeError('Invalid FLAC read limit');
 const timing=createFlacPacketTiming({maxPendingPackets:pendingLimit});
 const size=input.size,readAt=input.readAt.bind(input);
 // readInto is an optional synchronous provider capability, never emulated by a copy.
 const readInto=input.readInto?.bind(input);
 const controller=new AbortController(),local=controller.signal,forward=()=>controller.abort(signal.reason);
 const source=Object.freeze({size,async readAt(offset:bigint,length:number){local.throwIfAborted();const bytes=await waitForFlacAbort(readAt(offset,length,local),local);local.throwIfAborted();return bytes;},
  ...(readInto?{readInto(offset:bigint,target:Uint8Array){local.throwIfAborted();const count=readInto(offset,target,local);local.throwIfAborted();return count;}}:{})});
 const scoped=Object.freeze({...policy,resources:Object.freeze({allocate}),maxReadBytes:readLimit,signal:local,checkpoint:async()=>{await waitForFlacAbort(checkpoint?.(),local);local.throwIfAborted();}});
 signal.addEventListener('abort',forward,{once:true});if(signal.aborted)forward();
 const active=new Set<AsyncIterator<FlacPacketChunk,void,unknown>>();let closed=false,started=false,completed=false;
 let ranges:ReturnType<typeof openFlacPacketRanges>|undefined,iterator:AsyncGenerator<FlacDemuxPacket,void,unknown>|undefined,closing:Promise<void>|undefined;
 async function close(){if(!closing){controller.abort(new Error('FLAC demux closed'));closing=(async()=>{try{const results=await Promise.allSettled([...active].map(reader=>reader.return?.()));const iteratorResults=await Promise.allSettled([iterator?.return()]);const errors=[...results,...iteratorResults].flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'FLAC payload cleanup failed');}finally{active.clear();ranges?.close();timing.close();signal.removeEventListener('abort',forward);closed=true;}})();}return closing;}
 try{
  const context=await readFlacDemuxMetadata(source,scoped),metadata=context.metadata;
  if(metadata.framesOffset===null)throw new Error('Unhandled FLAC metadata continuation');
  ranges=openFlacPacketRanges(source,{...scoped,startOffset:metadata.framesOffset});
  function chunks(inputSource:FlacRangeSource,range:{sourceOffset:bigint;bytes:bigint},limit:bigint){let used=false;const reader=readFlacPacketChunks(inputSource,range,{...scoped,maxPacketBytes:limit});
   return {reader,iterable:Object.freeze({[Symbol.asyncIterator](){local.throwIfAborted();if(used||closed)throw new Error('FLAC chunks are one-shot or closed');used=true;if(active.size>=pendingLimit)throw new RangeError('Pending FLAC payload reader limit exceeded');const payload=reader[Symbol.asyncIterator]();active.add(payload);
    return {async next(){try{const item=await payload.next();if(item.done)active.delete(payload);return item;}catch(error){active.delete(payload);throw error;}},async return(){try{return await payload.return?.()??{done:true as const,value:undefined};}finally{active.delete(payload);}},[Symbol.asyncIterator](){return this;}};
   }})};
  }
  const attachedPictures=Object.freeze(context.pictures.map(item=>{if(!item.parsed.dataRange)throw new Error('Missing picture data range');return Object.freeze({descriptor:item.parsed.descriptor,dataRange:item.parsed.dataRange,chunks:chunks(item.source,item.parsed.dataRange,BigInt(maxPictureBytes)).iterable});}));
  const timeBase=metadata.kind==='flac-streaminfo'?metadata.streamInfo?.timeBase??null:null;
  async function* timed(){try{for await(const range of ranges!)for(const packet of timing.push(range))yield packet;for(const packet of timing.finish())yield packet;}finally{timing.close();}}
  async function* iterate():AsyncGenerator<FlacDemuxPacket,void,unknown>{try{for await(const packet of timed()){
   const payload=chunks(source,packet.range,maxPacketBytes);yield Object.freeze({...packet,timeBase,chunks:payload.iterable});local.throwIfAborted();if(!payload.reader.metrics.completed)throw new Error('Consume packet chunks before advancing demux');
  }completed=true;}finally{ranges?.close();try{const results=await Promise.allSettled([...active].map(payload=>payload.return?.()));const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'FLAC payload cleanup failed');}finally{active.clear();}}}
  return Object.freeze({metadata,attachedPictures,packets:Object.freeze({[Symbol.asyncIterator](){local.throwIfAborted();if(started||closed)throw new Error('FLAC demux is one-shot or closed');started=true;iterator=iterate();return iterator;}}),close,get metrics(){return Object.freeze({closed,completed,activePayloadReaders:active.size,timing:timing.metrics,ranges:ranges!.metrics,defaultSampleTimestampFillImplemented:true,fullNativeTimestampMappingImplemented:false,avioPartialSchedulingImplemented:false});}});
 }catch(error){try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],'FLAC demux failed during cleanup');}throw error;}
}
export interface FlacDemuxPacket extends TimedFlacRange {
 readonly timeBase:Readonly<{num:bigint;den:bigint}>|null;
 readonly chunks:AsyncIterable<FlacPacketChunk>;
}
