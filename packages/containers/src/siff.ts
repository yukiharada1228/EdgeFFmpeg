// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/siff.c, SOUN files only (pinned FFmpeg 946fcce0). See NOTICE-SIFF.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class SiffError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface SiffOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal;
  /** Input -ss in microseconds; any nonzero seek is refused. */
  readonly seek?:bigint}
export interface SiffInfo extends RawPcmInfo {readonly container:'siff';
  /** SHDR rate (RL16@24) and bits (RL16@26). */
  readonly bits:number;
  /** Native block_align = rate*(bits>>3): bytes, and so u8 samples, per native packet. */
  readonly packetSamples:number;
  /** Set when the data does not end on a native packet boundary: native copy flags that short packet CORRUPT. */
  readonly copyRefusal?:string}
export interface SiffInput extends Omit<RawPcmInput,'info'> {readonly info:SiffInfo}
/** "SIFF" size "SOUN" "SHDR" be32(8) unknown(4) rate(le16) bits(le16) "BODY" size, then u8 samples to EOF. */
const headerBytes=36,probeBytes=12,tag=(bytes:Uint8Array,offset:number)=>String.fromCharCode(bytes[offset]!,bytes[offset+1]!,bytes[offset+2]!,bytes[offset+3]!);
// AVERROR_INVALIDDATA from siff_read_header: the same status on every host.
const invalid=(message:string)=>containerRefusal(message,183);
async function readHead(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new SiffError('invalid-data','Unexpected SIFF header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** The first `length` bytes, zero-padded past EOF as avio reads (and the probe buffer) are. */
async function padded(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new SiffError('resource-limit','Invalid SIFF read budget');
  const available=input.size<BigInt(length)?Number(input.size<0n?0n:input.size):length,bytes=new Uint8Array(length);
  bytes.set(await readHead(input,available,maxReadBytes,signal));return bytes;
}
/** siff_probe over the zero-padded probe buffer: "SIFF", then "VBV1" or "SOUN" at byte 8. */
export function matchesSiff(bytes:Uint8Array):boolean{if(bytes.length<probeBytes)return false;const kind=tag(bytes,8);return tag(bytes,0)==='SIFF'&&(kind==='VBV1'||kind==='SOUN');}
/** Bounded confirmation after the 'SIFF' head: reads at most the 12 bytes siff_probe inspects. VBV1 files are detected, then refused by open. */
export async function probeSiff(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{return matchesSiff(await padded(input,probeBytes,maxReadBytes,signal));}
/** Finite range-backed SIFF SOUN: a 36-byte header, then pcm_u8 mono to EOF in native packets of rate*(bits>>3) bytes. */
export async function openSiff(input:ReadHandle,options:SiffOptions):Promise<SiffInput>{
  const {maxReadBytes,signal,seek=0n}=options,header=await padded(input,headerBytes,maxReadBytes,signal),view=new DataView(header.buffer);
  // siff_read_header's checks in its order; reads past EOF see zeros, as avio_rl32 does.
  if(tag(header,0)!=='SIFF')throw invalid('Invalid SIFF header');
  const kind=tag(header,8);
  if(kind==='VBV1')throw containerRefusal('SIFF VBV1 video is not implemented');
  if(kind!=='SOUN')throw invalid('Not a VBV file');
  if(tag(header,12)!=='SHDR')throw invalid('Header chunk is missing');
  if(view.getUint32(16,false)!==8)throw invalid('Header chunk size is incorrect');
  const sampleRate=view.getUint16(24,true),bits=view.getUint16(26,true),packetSamples=sampleRate*(bits>>3);
  if(tag(header,28)!=='BODY')throw invalid("'BODY' chunk is missing");
  // Native opens these as an empty stream (av_get_packet of nothing, or of zero bytes, is EOF) and exits 0; not mirrored.
  if(input.size<BigInt(headerBytes))throw new SiffError('invalid-data','Truncated SIFF header');
  if(!packetSamples)throw new SiffError('unsupported',`SIFF input with rate ${sampleRate} and ${bits} bits has no packets; not implemented`);
  // Native input -ss goes through the generic index; not mirrored.
  if(seek>0n)throw containerRefusal('SIFF input seeking is not implemented');
  const offset=BigInt(headerBytes),dataBytes=input.size-offset;
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec:'pcm_u8',channels:1,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  // av_get_packet flags a short final packet AV_PKT_FLAG_CORRUPT, which copy framecrc prints as F=0x3.
  const shortTail=dataBytes%BigInt(packetSamples)!==0n;
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'siff' as const,bits,packetSamples,...(shortTail?{copyRefusal:'SIFF stream copy of a short final packet is not implemented'}:{})}),packets:raw.packets});
}
/** Registered by `export {siff} from './siff.js';` in registry.ts. Demux only: native has no siff muxer. */
export const siff=defineContainer({
  name:'siff',
  // Exact head "SIFF", which no other registered head matches; the confirm reads the 12 bytes siff_probe inspects.
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='SIFF',confirm:probeSiff},headerBytes,
    open:(source,{maxReadBytes,signal,seek})=>openSiff(source,{maxReadBytes,signal,seek}),packetSpan:(info:SiffInfo)=>BigInt(info.packetSamples)}
});
