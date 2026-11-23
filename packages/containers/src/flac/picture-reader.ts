/* Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * libavformat/flac_picture.c and id3v2.c, Copyright (c) 2001/2003 Fabrice Bellard;
 * libavutil/base64.c, Copyright (c) 2006 Ryan Martell.
 * LGPL-2.1-or-later. Metadata characterization only; no image decoding or full demux claim.
 */
/* SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
 * Owned VFS field driver, not image decoding or complete demux integration.
 */
import {createFlacPictureHeaderMachine} from './picture-header-machine.js';
import {waitForFlacAbort} from './abort-wait.js';
import type {FlacRangeSource} from './types.js';
import type {FlacPictureReadOptions,FlacPictureField} from './picture-types.js';
export async function readFlacPictureRange(input:FlacRangeSource,{payloadOffset,payloadBytes,resources,signal,maxReadBytes=65536,checkpoint,...limits}:FlacPictureReadOptions){
 if(typeof resources?.allocate!=='function'||typeof signal?.throwIfAborted!=='function')throw new TypeError('Picture reader requires allocator and signal');signal.throwIfAborted();const size=input.size,readAt=input.readAt.bind(input),readInto=input.readInto?.bind(input);if(typeof size!=='bigint'||size<0n||size>0x7fffffffffffffffn||typeof payloadOffset!=='bigint'||payloadOffset<0n||!Number.isSafeInteger(payloadBytes)||payloadBytes<0||payloadOffset+BigInt(payloadBytes)>size||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||maxReadBytes>65536)throw new RangeError('Invalid picture read bounds');
 const parser=createFlacPictureHeaderMachine({payloadBytes,...limits}),metrics={readCalls:0,bytesRead:0n,maximumRead:0,ownedBufferBytes:0,peakOwnedBufferBytes:0,closed:false};
 async function step(request:FlacPictureField){const {offset,length}=request;if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>payloadBytes)throw new Error('Invalid picture field request');const owned=resources.allocate(length);let released=false,reading=false;const release=()=>{if(!released&&!reading){released=true;signal.removeEventListener('abort',release);owned.release();metrics.ownedBufferBytes-=length;}};metrics.ownedBufferBytes+=length;metrics.peakOwnedBufferBytes=Math.max(metrics.peakOwnedBufferBytes,metrics.ownedBufferBytes);signal.addEventListener('abort',release,{once:true});
  try{let written=0;while(written<length){signal.throwIfAborted();await waitForFlacAbort(checkpoint?.(),signal);signal.throwIfAborted();const amount=Math.min(maxReadBytes,length-written);metrics.readCalls++;metrics.maximumRead=Math.max(metrics.maximumRead,amount);let received:number;if(readInto){reading=true;try{received=readInto(payloadOffset+BigInt(offset+written),owned.data.subarray(written,written+amount),signal);}finally{reading=false;}signal.throwIfAborted();if(!Number.isSafeInteger(received)||received<1||received>amount)throw new Error('Invalid or premature picture read');}else{let pending;try{pending=readAt(payloadOffset+BigInt(offset+written),amount,signal);}catch(error){signal.throwIfAborted();throw error;}const bytes=await waitForFlacAbort(pending,signal);signal.throwIfAborted();if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>amount)throw new Error('Invalid or premature picture read');owned.data.set(bytes,written);received=bytes.length;}written+=received;metrics.bytesRead+=BigInt(received);}signal.throwIfAborted();return parser.next(owned.data);}finally{release();}
 }
 try{let item=parser.next();while(!item.done)item=await step(item.value);const descriptor=item.value,dataRange=(descriptor.kind==='accepted'||descriptor.kind==='needs-truncation-read')?Object.freeze({sourceOffset:payloadOffset+BigInt(descriptor.dataOffset),bytes:BigInt(descriptor.dataBytes)}):null;return Object.freeze({descriptor,dataRange,get metrics(){return Object.freeze({...metrics,providerBuffersCoreAccounted:false,wholeImagePayloadBuffered:false,signaturePeekLimitBytes:8});}});}finally{parser.return(undefined as never);metrics.closed=true;}
}
