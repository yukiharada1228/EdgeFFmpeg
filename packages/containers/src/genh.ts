// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/genh.c with utils.c av_get_packet semantics (pinned FFmpeg 946fcce0). See NOTICE-GENH.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class GenhError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface GenhOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal;
  /** Input -ss in microseconds; genh has no read_seek, and native's generic seek is not mirrored, so a nonzero seek is refused. */
  readonly seek?:bigint}
export interface GenhInfo extends RawPcmInfo {readonly container:'genh';
  /** interleave_size: samples per native packet (av_get_packet of block_align = interleave*channels bytes). */
  readonly interleave:number;
  /** The rl32 at offset 20 (st->duration); informational, packets run to EOF as native does. */
  readonly headerDuration:bigint;
  /** start_offset after the header_size rule (0x800 when header_size is 0); data runs from it to EOF. */
  readonly startOffset:bigint}
export interface GenhInput extends Omit<RawPcmInput,'info'> {readonly info:GenhInfo}
/** Native exit statuses: AVERROR_PATCHWELCOME and AVERROR_INVALIDDATA as the ffmpeg CLI reports them. */
const headerBytes=60,patchWelcome=176,invalidData=183,intMax=2147483647;
/** AVERROR(EINVAL) on Linux: native fails to open the pcm_u8 decoder (and stream copy) for sample rate 0. */
const invalidArgument=234;
// genh_read_header's codec switch: 13 is the ported pcm_u8; the other known ids are native codecs left unported (3, 4 and 5 are always planar here, since block_align>0).
const unported:Readonly<Record<number,string>>={0:'adpcm_psx',1:'adpcm_ima_wav',2:'adpcm_dtk',3:'pcm_s16be_planar',4:'pcm_s16le_planar',5:'pcm_s8_planar',6:'sdx2_dpcm',7:'adpcm_ima_ws',10:'adpcm_aica',11:'adpcm_ima_wav',12:'adpcm_thp',17:'adpcm_ima_qt'};
const int32=(value:number)=>value|0;
async function readHead(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new GenhError('invalid-data','Unexpected GENH header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** genh_probe over the zero-padded probe buffer: 'GENH', then channels rl32 at offset 4 in 1..0xFFFF. */
export function matchesGenh(bytes:Uint8Array):boolean{
  if(String.fromCharCode(...bytes.subarray(0,4))!=='GENH')return false;
  const channels=((bytes[4]??0)|((bytes[5]??0)<<8)|((bytes[6]??0)<<16)|((bytes[7]??0)<<24))>>>0;return channels>0&&channels<=0xffff;
}
/** Bounded confirmation after the 'GENH' head: reads at most the 8 bytes genh_probe inspects. */
export async function probeGenh(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new GenhError('resource-limit','Invalid GENH read budget');
  const available=input.size<8n?Number(input.size<0n?0n:input.size):8,bytes=new Uint8Array(8);
  bytes.set(await readHead(input,available,maxReadBytes,signal));return matchesGenh(bytes);
}
/** Finite range-backed GENH: a 60-byte header, then interleaved pcm_u8 from start_offset (absolute) to EOF in packets of interleave samples. */
export async function openGenh(input:ReadHandle,options:GenhOptions):Promise<GenhInput>{
  const {maxReadBytes,signal,seek=0n}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new GenhError('resource-limit','Invalid GENH read budget');
  if(input.size<BigInt(headerBytes))throw new GenhError('invalid-data','Truncated GENH header');
  const header=await readHead(input,headerBytes,maxReadBytes,signal),view=new DataView(header.buffer),u32=(at:number)=>view.getUint32(at,true);
  // genh_read_header skips the magic unchecked; the checks below keep its order and its int casts.
  const channels=int32(u32(4));if(channels<=0)throw containerRefusal('Invalid GENH channel count',invalidData);
  const interleave=int32(u32(8));if(interleave<0||interleave>Math.trunc(intMax/channels))throw containerRefusal('Invalid GENH interleave size',invalidData);
  let blockAlign=interleave*channels;
  const sampleRate=int32(u32(12));if(sampleRate<0)throw containerRefusal('Invalid GENH sample rate',invalidData);
  const headerDuration=BigInt(u32(20)),codecId=u32(24);
  if(codecId===1||codecId===11){if(channels>Math.trunc(intMax/36))throw containerRefusal('Invalid GENH channel count',invalidData);blockAlign=36*channels;}
  else if(codecId===6&&blockAlign>Math.trunc(intMax/1024))throw containerRefusal('Invalid GENH block size',invalidData);
  else if(codecId!==13&&!Object.hasOwn(unported,codecId))throw containerRefusal(`GENH codec ${codecId} is not implemented`,patchWelcome);
  const headerSize=u32(32);let start=BigInt(u32(28));
  if(headerSize>start)throw containerRefusal('Invalid GENH header size',invalidData);
  if(!headerSize)start=0x800n;
  // THP reads coefficient tables and may change block_align; it is refused before native's later checks.
  if(codecId===12)throw new GenhError('unsupported','GENH codec 12 (adpcm_thp) is not implemented');
  if(blockAlign<=0)throw containerRefusal('Invalid GENH block size',invalidData);
  if(codecId!==13)throw new GenhError('unsupported',`GENH codec ${codecId} (${unported[codecId]}) is not implemented`);
  if(!sampleRate)throw containerRefusal('Invalid GENH sample rate 0',invalidArgument);
  if(channels>65535)throw new GenhError('unsupported',`GENH channel count ${channels} is not implemented`);
  if(start>=input.size)throw new GenhError('unsupported','GENH input without payload is not implemented');
  const dataBytes=input.size-start;
  if(seek>0n)throw containerRefusal('GENH input seeking is not implemented');
  if(dataBytes%BigInt(channels))throw new GenhError('unsupported','GENH partial trailing sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(start+position,length,abort)},{codec:'pcm_u8',channels,sampleRate,channelMask:channels===1?0x4:channels===2?0x3:null,maxReadBytes,...(signal?{signal}:{})});
  // av_get_packet flags a short final packet AV_PKT_FLAG_CORRUPT and genh_read_packet keeps it: copy framecrc would print F=0x3.
  const short=dataBytes%BigInt(blockAlign)!==0n;
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:start,container:'genh' as const,interleave,headerDuration,startOffset:start,...(short?{copyRefusal:'GENH stream copy of a short final packet is not implemented'}:{})}),packets:raw.packets});
}
/** Registered by `export {genh} from './genh.js';` in registry.ts. Demux only: native has no genh muxer. */
export const genh=defineContainer({
  name:'genh',
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='GENH',confirm:probeGenh},headerBytes,
    open:(source,{maxReadBytes,signal,seek})=>openGenh(source,{maxReadBytes,signal,seek}),packetSpan:(info:GenhInfo)=>BigInt(info.interleave)}
});
