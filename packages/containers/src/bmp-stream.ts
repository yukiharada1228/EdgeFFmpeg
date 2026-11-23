// SPDX-License-Identifier: LGPL-2.1-or-later
// Framing follows pinned BMP parser semantics; see NOTICE-BMP-STREAM.
import type {ReadHandle} from '@edge-ffmpeg/core';
import type {MediaPacket,Rational} from '@edge-ffmpeg/avutil';
export class BmpStreamError extends Error {}
export interface BmpStreamOptions {readonly frameRate:Rational;readonly maxReadBytes:number;readonly maxPacketBytes:number;readonly maxFrames:number;readonly signal?:AbortSignal}
/** Finite BMP image stream with one independently owned packet in flight.
 * This framing path requires an aligned BMP signature and a declared frame size.
 */
export function openBmpStream(input:ReadHandle,options:BmpStreamOptions):AsyncIterable<MediaPacket>{
 const {maxReadBytes,maxPacketBytes,maxFrames,signal}=options,rate={...options.frameRate},size=input.size;
 signal?.throwIfAborted();
 for(const limit of [maxReadBytes,maxPacketBytes,maxFrames])if(!Number.isSafeInteger(limit)||limit<1||limit>2147483647)throw new BmpStreamError('Invalid BMP stream resource budget');
 if(typeof size!=='bigint'||size<0n||size>(1n<<63n)-1n||typeof rate.num!=='bigint'||typeof rate.den!=='bigint'||rate.num<=0n||rate.den<=0n||rate.num>2147483647n||rate.den>2147483647n)throw new BmpStreamError('Invalid BMP stream size or frame rate');
 if(maxPacketBytes<18)throw new BmpStreamError('BMP stream packet budget is smaller than its header');
 const read=async(offset:bigint,target:Uint8Array)=>{
  let filled=0;while(filled<target.length){signal?.throwIfAborted();const length=Math.min(maxReadBytes,target.length-filled),chunk=await input.readAt(offset+BigInt(filled),length,signal);signal?.throwIfAborted();if(!(chunk instanceof Uint8Array)||chunk.length<1||chunk.length>length)throw new BmpStreamError('Invalid BMP stream range read');target.set(chunk,filled);filled+=chunk.length;}
 };
 return {async *[Symbol.asyncIterator](){
  let offset=0n,index=0n;
  while(offset<size){
   signal?.throwIfAborted();if(index>=BigInt(maxFrames))throw new BmpStreamError('BMP stream frame budget exceeded');
   if(size-offset<18n)throw new BmpStreamError('Truncated BMP stream header');
   const header=new Uint8Array(18);await read(offset,header);const view=new DataView(header.buffer),declared=view.getUint32(2,true),dib=view.getUint32(14,true);
   if(view.getUint16(0,true)!==0x4d42||declared<18||dib<12||dib>200)throw new BmpStreamError('Invalid BMP stream framing');
   const available=size-offset,length=Number(available<BigInt(declared)?available:BigInt(declared));
   if(length>maxPacketBytes)throw new BmpStreamError('BMP stream packet budget exceeded');
   const data=new Uint8Array(length);data.set(header);await read(offset+18n,data.subarray(18));
   signal?.throwIfAborted();yield {streamIndex:0,data,pts:index,dts:index,duration:1n,timeBase:{num:rate.den,den:rate.num},flags:1};
   offset+=BigInt(length);index++;
  }
 }};
}
