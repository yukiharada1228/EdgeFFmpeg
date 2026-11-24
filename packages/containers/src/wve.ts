// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/wvedec.c with pcm.c packet semantics (pinned FFmpeg 946fcce0). See NOTICE-WVE.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {defineContainer} from './registry-descriptor.js';
export class WveError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface WveOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal;
  /** Input -ss in microseconds; a nonzero seek is refused when the header duration differs from the physical sample count. */
  readonly seek?:bigint}
export interface WveInfo extends RawPcmInfo {readonly container:'wve';
  /** The rb32 at offset 18 (st->duration); informational, packets run to EOF as native does. */
  readonly headerDuration:bigint}
export interface WveInput extends Omit<RawPcmInput,'info'> {readonly info:WveInfo}
// wve_probe: 18 bytes of magic, then bytes 22..31 fixed; offsets 18..21 hold the duration.
const headerBytes=32,magic=[0x41,0x4c,0x61,0x77,0x53,0x6f,0x75,0x6e,0x64,0x46,0x69,0x6c,0x65,0x2a,0x2a,0x00,0x0f,0x10],fixed=[0,0,0,1,0,0,0,0,0,0];
async function readHead(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new WveError('invalid-data','Unexpected WVE header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** wve_probe over the zero-padded 32-byte probe buffer. */
export function matchesWve(bytes:Uint8Array):boolean{return magic.every((value,index)=>bytes[index]===value)&&fixed.every((value,index)=>(bytes[22+index]??0)===value);}
/** Bounded confirmation after the 'ALaw' head: reads at most the 32 bytes native read_probe inspects. */
export async function probeWve(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new WveError('resource-limit','Invalid WVE read budget');
  const available=input.size<BigInt(headerBytes)?Number(input.size<0n?0n:input.size):headerBytes,bytes=new Uint8Array(headerBytes);
  bytes.set(await readHead(input,available,maxReadBytes,signal));return matchesWve(bytes);
}
/** Finite range-backed Psion 3 audio: a 32-byte header, then A-law mono 8000 Hz to EOF. */
export async function openWve(input:ReadHandle,options:WveOptions):Promise<WveInput>{
  const {maxReadBytes,signal,seek=0n}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new WveError('resource-limit','Invalid WVE read budget');
  if(input.size<BigInt(headerBytes))throw new WveError('invalid-data','Truncated WVE header');
  const header=await readHead(input,headerBytes,maxReadBytes,signal);
  // wve_read_header skips the magic unchecked: under -f wve native demuxes any 32-byte header.
  const headerDuration=BigInt(new DataView(header.buffer).getUint32(18,false)),offset=BigInt(headerBytes),dataBytes=input.size-offset;
  if(seek>0n&&headerDuration!==dataBytes)throw new WveError('unsupported','WVE input seek with a header duration that differs from the data length is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec:'pcm_alaw',channels:1,sampleRate:8000,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'wve' as const,headerDuration}),packets:raw.packets});
}
/** Registered by `export {wve} from './wve.js';` in registry.ts. Demux only: native has no wve muxer. */
export const wve=defineContainer({
  name:'wve',
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='ALaw',confirm:probeWve},headerBytes,open:(source,{maxReadBytes,signal,seek})=>openWve(source,{maxReadBytes,signal,seek})}
});
