/* Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * libavformat/flac_picture.c and id3v2.c, Copyright (c) 2001/2003 Fabrice Bellard;
 * libavutil/base64.c, Copyright (c) 2006 Ryan Martell.
 * LGPL-2.1-or-later. Metadata characterization only; no image decoding or full demux claim.
 */
/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Random-access glue for pinned av_base64_decode terminal/validation semantics.
 * See ../../NOTICE-FLAC-PARSER. Holds encoded text, not a whole decoded payload.
 * readAt allocates provider buffers; readInto writes synchronously into caller-owned
 * storage with no decoded scratch allocation. Metrics count both read paths;
 * providerAllocatedBytes counts only readAt allocations, never caller storage.
 */
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export class Base64SourceLimitError extends Error{}
export function createReferenceBase64Source(text:string,{signal,maxEncodedChars=1048576,maxDecodedBytes=1048576,maxReadBytes=65536}:{signal:AbortSignal;maxEncodedChars?:number;maxDecodedBytes?:number;maxReadBytes?:number}){
 if(typeof text!=='string'||typeof signal?.throwIfAborted!=='function')throw new TypeError('Base64 source requires text and signal');signal.throwIfAborted();if(![maxEncodedChars,maxDecodedBytes,maxReadBytes].every(n=>Number.isSafeInteger(n)&&n>0)||maxReadBytes>65536)throw new RangeError('Invalid base64 source bounds');if(text.length>maxEncodedChars)throw new Base64SourceLimitError('Encoded picture budget exceeded');
 let symbols=0;for(const char of text){if(char==='='||char==='\0')break;if(alphabet.indexOf(char)<0)return null;symbols++;}const count=Math.floor(symbols/4)*3+(symbols%4>=2?symbols%4-1:0);if(count>maxDecodedBytes)throw new Base64SourceLimitError('Decoded picture budget exceeded');let reads=0,generated=0n,peak=0;
 const digit=(index:number)=>index<symbols?alphabet.indexOf(text[index]!):0;
 const validate=(offset:bigint,length:number,readSignal:AbortSignal)=>{signal.throwIfAborted();readSignal.throwIfAborted();if(typeof offset!=='bigint'||offset<0n||offset>BigInt(count)||!Number.isSafeInteger(length)||length<0||length>maxReadBytes)throw new RangeError('Invalid base64 picture read');return Math.min(length,count-Number(offset));};
 const decode=(offset:bigint,bytes:Uint8Array,amount:number)=>{const start=Number(offset);for(let i=0;i<amount;i++){const absolute=start+i,group=Math.floor(absolute/3)*4,part=absolute%3;bytes[i]=part===0?(digit(group)<<2)|(digit(group+1)>>4):part===1?(digit(group+1)<<4)|(digit(group+2)>>2):(digit(group+2)<<6)|digit(group+3);}};
 let readAtCalls=0,readIntoCalls=0,providerAllocatedBytes=0n;
 return {size:BigInt(count),async readAt(offset:bigint,length:number,readSignal=signal){const amount=validate(offset,length,readSignal),bytes=new Uint8Array(amount);decode(offset,bytes,amount);reads++;readAtCalls++;generated+=BigInt(amount);providerAllocatedBytes+=BigInt(amount);peak=Math.max(peak,amount);return bytes;},
  readInto(offset:bigint,destination:Uint8Array,readSignal=signal):number{if(!(destination instanceof Uint8Array))throw new TypeError('Base64 destination must be Uint8Array');const amount=validate(offset,destination.length,readSignal);decode(offset,destination,amount);reads++;readIntoCalls++;generated+=BigInt(amount);peak=Math.max(peak,amount);return amount;},
  get metrics(){return Object.freeze({reads,generatedBytes:generated,peakReadBytes:peak,readAtCalls,readIntoCalls,providerAllocatedBytes,readIntoDestinationOwnership:'caller' as const,wholeDecodedPayloadBuffered:false,providerBuffersCoreAccounted:false});}};
}
