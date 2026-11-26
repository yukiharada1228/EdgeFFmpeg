// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/fsb.c with av_get_packet semantics (pinned FFmpeg 946fcce0). See NOTICE-FSB.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class FsbError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface FsbInfo extends RawPcmInfo {readonly container:'fsb';readonly codec:'pcm_s16le';readonly format:number;
  /** The rl32 at offset 56 (st->duration); informational, packets run to EOF as native does. */
  readonly headerDuration:bigint;
  /** Set when the payload does not end on a 4096*channels-byte packet (ContainerStreamInfo.copyRefusal). */
  readonly copyRefusal?:string}
export interface FsbInput extends Omit<RawPcmInput,'info'> {readonly info:FsbInfo}
export interface FsbOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal}
/** fsb_read_header (version 3) reads through the u16 channel count at 86; fsb_probe inspects bytes 0..7. */
const headerBytes=88,probeBytes=8,packetSamples=2048,maxChannels=512,pcmFlag=0x100,
  /** INT_MAX/2: from 2^30 Hz the CLI's audio_samplerate_update (fftools/ffmpeg_dec.c) finds 1 >= INT_MAX/rate and moves decoded
   * timestamps to a 1/28224000 time base, so decoded pts leave the sample clock; these rates are refused for every output. */
  maxExactRate=1073741823,adpcmFlags:ReadonlyArray<readonly [number,string]>=[[0x00400000,'adpcm_ima_wav'],[0x00800000,'adpcm_psx'],[0x02000000,'adpcm_thp']];
/** AVERROR_PATCHWELCOME and AVERROR_INVALIDDATA are FFERRTAG values, so the CLI status is the same on every host. */
const patchWelcome=176,invalid=183;
/** fsb_probe over the zero-padded probe buffer: "FSB", a version digit 1..5, then RL32@4 == 1. */
export function matchesFsb(bytes:Uint8Array):boolean{
  if(bytes.length<4||bytes[0]!==0x46||bytes[1]!==0x53||bytes[2]!==0x42||bytes[3]!<0x31||bytes[3]!>0x35)return false;
  return bytes.length<probeBytes||(bytes[4]!|bytes[5]!<<8|bytes[6]!<<16|bytes[7]!<<24)===1;
}
async function readHead(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new FsbError('invalid-data','Unexpected FSB header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** The first `length` bytes zero-padded past EOF, as avio and the probe buffer read them. */
async function paddedHead(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const head=new Uint8Array(length),available=input.size<BigInt(length)?Number(input.size<0n?0n:input.size):length;head.set(await readHead(input,available,maxReadBytes,signal));return head;
}
/** Bounded confirmation after an "FSB1".."FSB5" head: reads at most the 8 bytes fsb_probe inspects. */
export async function probeFsb(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new FsbError('resource-limit','Invalid FSB read budget');
  return matchesFsb(await paddedHead(input,probeBytes,maxReadBytes,signal));
}
/** Finite range-backed FSB3 PCM: fsb_read_header field checks with native statuses, then pcm_s16le from RL32@8 + 0x18 (absolute) to EOF. */
export async function openFsb(input:ReadHandle,options:FsbOptions):Promise<FsbInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new FsbError('resource-limit','Invalid FSB read budget');
  // avio reads past EOF as zeros, so every field check runs over the zero-padded header before the truncation refusal.
  const head=await paddedHead(input,headerBytes,maxReadBytes,signal),view=new DataView(head.buffer),version=head[3]!-0x30;
  if(version===4)throw new FsbError('unsupported','FSB4 (XMA2 and THP) demuxing is not implemented');
  if(version!==3)throw containerRefusal(`FSB version ${version} is not supported`,patchWelcome);
  const offset=BigInt(view.getUint32(8,true))+0x18n,headerDuration=BigInt(view.getUint32(56,true)),format=view.getUint32(72,true),sampleRate=view.getInt32(76,true),channels=view.getUint16(86,true);
  if(sampleRate<=0)throw containerRefusal('Invalid FSB sample rate',invalid);
  if(!channels)throw containerRefusal('Invalid FSB channel count',invalid);
  if(!(format&pcmFlag)){
    const adpcm=adpcmFlags.find(([flag])=>format&flag);
    if(adpcm)throw new FsbError('unsupported',`FSB3 ${adpcm[1]} decoding is not implemented`);
    throw containerRefusal(`Unsupported FSB format 0x${format.toString(16).toUpperCase()}`,patchWelcome);
  }
  if(input.size<BigInt(headerBytes))throw new FsbError('unsupported','Truncated FSB header is not implemented');
  if(channels>maxChannels)throw new FsbError('unsupported',`FSB channel count above ${maxChannels} is not implemented`);
  if(sampleRate>maxExactRate)throw new FsbError('unsupported',`FSB sample rates above ${maxExactRate} are not implemented`);
  // avio_skip seeks to the absolute offset, backwards into the header when it is below 88.
  if(offset>input.size)throw new FsbError('unsupported','FSB data offset beyond the end of the file is not implemented');
  const dataBytes=input.size-offset,blockAlign=2*channels;
  if(dataBytes%BigInt(blockAlign))throw new FsbError('unsupported','FSB partial trailing sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec:'pcm_s16le',channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  // av_get_packet reads block_align = 4096*channels bytes and flags a short final packet AV_PKT_FLAG_CORRUPT, which copy framecrc prints as F=0x3.
  const shortTail=dataBytes%BigInt(packetSamples*blockAlign)!==0n;
  return Object.freeze({info:Object.freeze({...raw.info,codec:'pcm_s16le' as const,dataOffset:offset,container:'fsb' as const,format,headerDuration,
    ...(shortTail?{copyRefusal:'FSB stream copy of a short final packet (flagged corrupt natively) is not implemented'}:{})}),packets:raw.packets});
}
/** Registered by `export {fsb} from './fsb.js';` in registry.ts. Demux only: native has no FSB muxer. */
export const fsb=defineContainer({
  name:'fsb',
  // "FSB1".."FSB5" is an exact magic no other format's head matches, so precedence 100; confirm reads the 8 bytes fsb_probe reads.
  demux:{probe:{precedence:100,head:bytes=>matchesFsb(bytes.subarray(0,4)),confirm:probeFsb},headerBytes,
    async open(source,{maxReadBytes,signal,seek}){if(seek>0n)throw containerRefusal('FSB input seeking is not implemented');return openFsb(source,{maxReadBytes,signal});},
    packetSpan:()=>BigInt(packetSamples)}
});
