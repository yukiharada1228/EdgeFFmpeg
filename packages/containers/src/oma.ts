// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/omadec.c, oma.c, oma.h and id3v2.c ff_id3v2_match (pinned FFmpeg 946fcce0). See NOTICE-OMA.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class OmaError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface OmaInfo extends RawPcmInfo {readonly container:'oma';readonly codec:'pcm_s16be';
  /** RB16 at offset 6: 0xFFFF or 0xFF80 for an unencrypted file. */
  readonly eid:number;
  /** Set when the payload is not whole 1024-byte packets: native copy flags the short final packet CORRUPT. */
  readonly copyRefusal?:string}
export interface OmaInput extends Omit<RawPcmInput,'info'> {readonly info:OmaInfo}
export interface OmaOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal}
/** EA3_HEADER_SIZE; read_packet takes block_align = framesize = 1024 bytes per packet for OMA_CODECID_LPCM (256 stereo s16be frames). */
const headerBytes=96,probeBytes=6,id3Bytes=10,packetBytes=1024,lpcm=4,blockAlign=4,sampleRate=44100;
/** oma_read_header returns a literal -1 for a short header and for decrypt_init without an ID3 GEOB tag: status 255 on every host.
 * AVERROR_INVALIDDATA is 183; AVERROR(ENOSYS) for an unknown codec id is 218 with the Linux errno 38. */
const literal=255,invalidData=183,enosys=218;
/** ff_oma_codec_tags plus the ids oma_read_header routes (5, WMA, has no tag and falls to its default case). */
const nativeCodecs:Readonly<Record<number,string>>={0:'ATRAC3 (atrac3)',1:'ATRAC3+ (atrac3p)',2:'AAC (aac)',3:'MP3 (mp3)',33:'ATRAC3+ AL (atrac3pal)',34:'ATRAC3 AL (atrac3al)'};
/** ff_id3v2_match(buf, "ea3") over the first ten bytes. */
export function isEa3Tag(bytes:Uint8Array):boolean{
  return bytes.length>=id3Bytes&&bytes[0]===0x65&&bytes[1]===0x61&&bytes[2]===0x33&&bytes[3]!==0xff&&bytes[4]!==0xff&&[6,7,8,9].every(index=>!(bytes[index]!&0x80));
}
/** oma_read_probe without a leading ea3 tag: "EA3", any byte, then 0 and 96. */
export function isOmaHeader(bytes:Uint8Array):boolean{return bytes.length>=probeBytes&&bytes[0]===0x45&&bytes[1]===0x41&&bytes[2]===0x33&&bytes[4]===0&&bytes[5]===headerBytes;}
async function readHead(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new OmaError('invalid-data','Unexpected OMA header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** Bounded confirmation after the 'EA3' head: the six bytes oma_read_probe inspects. */
export async function probeOma(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new OmaError('resource-limit','Invalid OMA read budget');
  return input.size>=BigInt(probeBytes)&&isOmaHeader(await readHead(input,probeBytes,maxReadBytes,signal));
}
/** Finite range-backed untagged, unencrypted OMA LPCM: a 96-byte EA3 header, then stereo 44100 Hz s16be to EOF in 1024-byte packets. */
export async function openOma(input:ReadHandle,options:OmaOptions):Promise<OmaInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new OmaError('resource-limit','Invalid OMA read budget');
  // ff_id3v2_read runs first; a tag would export metadata and chapters and move the EA3 header, so it is refused before the header checks.
  const available=Number(input.size<BigInt(headerBytes)?(input.size<0n?0n:input.size):BigInt(headerBytes)),head=await readHead(input,available,maxReadBytes,signal);
  if(isEa3Tag(head))throw new OmaError('unsupported','OMA ID3v2 ea3 tag is not implemented');
  if(available<headerBytes)throw containerRefusal('Truncated OMA EA3 header',literal);
  if(!isOmaHeader(head))throw containerRefusal("Couldn't find the EA3 header",invalidData);
  const view=new DataView(head.buffer),eid=view.getUint16(6,false);
  if(eid!==0xffff&&eid!==0xff80)throw containerRefusal('OMA file is encrypted: no encryption header found',literal);
  const codecId=head[32]!;
  if(codecId!==lpcm){
    const name=nativeCodecs[codecId];
    if(name)throw new OmaError('unsupported',`OMA codec id ${codecId} ${name} is not implemented`);
    throw containerRefusal(`Unsupported OMA codec ${codecId}`,enosys);
  }
  const offset=BigInt(headerBytes),dataBytes=input.size-offset;
  if(dataBytes%BigInt(blockAlign))throw new OmaError('unsupported','OMA partial trailing sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec:'pcm_s16be',channels:2,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  // av_get_packet flags a short final packet AV_PKT_FLAG_CORRUPT (framecrc F=0x3), which stream copy would print.
  const copyRefusal=dataBytes%BigInt(packetBytes)?{copyRefusal:'OMA stream copy of a short final packet (AV_PKT_FLAG_CORRUPT) is not implemented'}:{};
  return Object.freeze({info:Object.freeze({...raw.info,codec:'pcm_s16be' as const,dataOffset:offset,container:'oma' as const,eid,...copyRefusal}),packets:raw.packets});
}
/** Registered by `export {oma} from './oma.js';` in registry.ts. Demux only: the native oma muxer writes ATRAC only. */
export const oma=defineContainer({
  name:'oma',
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes.subarray(0,3))==='EA3',confirm:probeOma},headerBytes,
    async open(source,{maxReadBytes,signal,seek}){if(seek>0n)throw containerRefusal('OMA input seeking is not implemented');return openOma(source,{maxReadBytes,signal});},
    packetSpan:(info:OmaInfo)=>BigInt(packetBytes/info.blockAlign)}
});
