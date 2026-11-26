// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/msf.c (msf_probe, msf_read_header, msf_read_packet) (pinned FFmpeg 946fcce0). See NOTICE-MSF.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class MsfError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type MsfCodec='pcm_s16be'|'pcm_s16le';
export interface MsfInfo extends RawPcmInfo {readonly container:'msf';readonly codecId:number;readonly sizeField:number;readonly copyRefusal?:string}
export interface MsfInput extends Omit<RawPcmInput,'info'> {readonly info:MsfInfo}
export interface MsfOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal;readonly seek?:bigint}
/** The fields msf_read_header reads: magic, codec, channels, size and rate, all RB32; the payload starts at 0x40. */
export interface MsfHeader {readonly codecId:number;readonly channels:number;readonly sizeField:number;readonly sampleRate:number}
/** Bytes msf_read_header reads (and msf_probe inspects), and the data offset it skips to. */
export const msfFieldBytes=20,msfDataOffset=64;
/** Samples per native packet: av_get_packet(1024 * channels) bytes of 16-bit PCM. */
export const msfPacketSamples=512;
/** INT_MAX / 1024: msf_read_header refuses channel counts at or above it. */
const channelLimit=2097151;
const codecs:Readonly<Record<number,MsfCodec>>={0:'pcm_s16be',1:'pcm_s16le'};
/** Codecs msf_read_header accepts that EdgeFFmpeg does not decode. */
const refusedCodecs:Readonly<Record<number,string>>={3:'adpcm_psx',4:'atrac3',5:'atrac3',6:'atrac3',7:'mp3'};
async function readFields(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array|null>{
  if(input.size<BigInt(length))return null;
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new MsfError('invalid-data','Unexpected MSF header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** Bounded msf_probe: "MSF" (any fourth byte) and nonzero RB32 channels and rate; the codec only changes native's score. */
export async function probeMsf(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new MsfError('resource-limit','Invalid MSF read budget');
  const bytes=await readFields(input,msfFieldBytes,maxReadBytes,signal);if(!bytes)return false;
  const view=new DataView(bytes.buffer);
  return bytes[0]===0x4d&&bytes[1]===0x53&&bytes[2]===0x46&&view.getUint32(8)!==0&&view.getUint32(16)!==0;
}
/** msf_read_header up to the codec switch, in native order: channels (183), rate as int (183), then the codec (176 for unknown ids). */
export async function readMsfHeader(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<MsfHeader>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new MsfError('resource-limit','Invalid MSF read budget');
  if(input.size<BigInt(msfDataOffset))throw new MsfError('unsupported','MSF inputs shorter than the 64-byte header are not implemented');
  const bytes=(await readFields(input,msfFieldBytes,maxReadBytes,signal))!,view=new DataView(bytes.buffer);
  const codecId=view.getUint32(4),channels=view.getInt32(8),sizeField=view.getUint32(12),sampleRate=view.getInt32(16);
  if(channels<=0||channels>=channelLimit)throw containerRefusal(`Invalid MSF channel count: ${view.getUint32(8)}`,183);
  if(sampleRate<=0)throw containerRefusal(`Invalid MSF sample rate: ${view.getUint32(16)}`,183);
  if(!Object.hasOwn(codecs,codecId)){
    const name=refusedCodecs[codecId];
    if(name)throw new MsfError('unsupported',`MSF codec ${codecId} (${name}) is not implemented`);
    throw containerRefusal(`MSF codec ${codecId} is not supported`,176);
  }
  return Object.freeze({codecId,channels,sizeField,sampleRate});
}
/** Finite range-backed MSF: 16-bit PCM from 0x40 to EOF, in native packets of 1024 * channels bytes. */
export async function openMsf(input:ReadHandle,options:MsfOptions):Promise<MsfInput>{
  const {maxReadBytes,signal,seek=0n}=options,header=await readMsfHeader(input,{maxReadBytes,...(signal?{signal}:{})}),{codecId,channels,sizeField,sampleRate}=header,codec=codecs[codecId]!;
  if(channels>65535)throw new MsfError('unsupported',`MSF inputs with ${channels} channels are not implemented`);
  const offset=BigInt(msfDataOffset),dataBytes=input.size-offset,blockAlign=BigInt(2*channels);
  if(dataBytes%blockAlign)throw new MsfError('unsupported','MSF partial sample frame is not implemented');
  if(seek>0n)throw containerRefusal('MSF input seeking is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  // av_get_packet flags a short final packet AV_PKT_FLAG_CORRUPT, which copy framecrc prints as F=0x3.
  const short=dataBytes%(blockAlign*BigInt(msfPacketSamples))!==0n;
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'msf' as const,codecId,sizeField,...(short?{copyRefusal:'MSF stream copy of a short final packet is not implemented'}:{})}),packets:raw.packets});
}
/** Registered by `export {msf} from './msf.js';` in registry.ts. Demux only. */
export const msf=defineContainer({
  name:'msf',
  // Exact "MSF" head with any fourth byte; the confirm reads the 20 bytes msf_probe inspects.
  demux:{probe:{precedence:100,head:bytes=>bytes[0]===0x4d&&bytes[1]===0x53&&bytes[2]===0x46,confirm:probeMsf},headerBytes:msfDataOffset,
    open:(source,{maxReadBytes,signal,seek})=>openMsf(source,{maxReadBytes,signal,seek}),packetSpan:()=>BigInt(msfPacketSamples)}
});
