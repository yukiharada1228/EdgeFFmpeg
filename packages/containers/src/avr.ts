// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/avr.c, utils.c ff_get_pcm_codec_id and pcm.c (pinned FFmpeg 946fcce0). See NOTICE-AVR.
import type {ReadHandle} from '@edge-ffmpeg/core';
import type {PcmCodec} from '@edge-ffmpeg/avutil';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class AvrError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type AvrCodec=Extract<PcmCodec,'pcm_s8'|'pcm_u8'|'pcm_s16be'|'pcm_u16be'|'pcm_s24be'|'pcm_u24be'|'pcm_s32be'|'pcm_u32be'>;
export interface AvrInfo extends RawPcmInfo {readonly container:'avr';readonly sign:number}
export interface AvrInput extends Omit<RawPcmInput,'info'> {readonly info:AvrInfo}
export interface AvrOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal}
/** Native exit statuses: AVERROR_PATCHWELCOME and AVERROR_INVALIDDATA as the ffmpeg CLI reports them. */
const headerBytes=128,patchWelcome=176,invalidData=183;
const signed:readonly AvrCodec[]=['pcm_s8','pcm_s16be','pcm_s24be','pcm_s32be'],unsigned:readonly AvrCodec[]=['pcm_u8','pcm_u16be','pcm_u24be','pcm_u32be'];
/** ff_get_pcm_codec_id(bps,0,1,sign): 'unmapped' is native AV_CODEC_ID_NONE; null is a native codec left unported (s64be, or a bps that is not a whole byte count). */
export function avrPcmCodec(bps:number,sign:number):AvrCodec|null|'unmapped'{
  if(!Number.isInteger(bps)||bps<=0||bps>64)return 'unmapped';
  const bytes=(bps+7)>>3,isSigned=(sign&(1<<(bytes-1)))!==0,codec=(isSigned?signed:unsigned)[bytes-1];
  if(!codec)return isSigned&&bytes===8?null:'unmapped';
  return bps%8?null:codec;
}
/** Finite range-backed AVR: a 128-byte header, then big-endian or 8-bit PCM to EOF. */
export async function openAvr(input:ReadHandle,options:AvrOptions):Promise<AvrInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new AvrError('resource-limit','Invalid AVR read budget');
  if(input.size<BigInt(headerBytes))throw new AvrError('invalid-data','Truncated AVR header');
  const header=new Uint8Array(headerBytes);let filled=0;
  while(filled<headerBytes){signal?.throwIfAborted();const requested=Math.min(headerBytes-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new AvrError('invalid-data','Unexpected AVR header read length');header.set(chunk,filled);filled+=chunk.length;}
  const view=new DataView(header.buffer);
  if(view.getUint32(0,false)!==0x32424954)throw new AvrError('invalid-data','Expected AVR signature');
  const chan=view.getUint16(12,false),bps=view.getUint16(14,false),sign=view.getUint16(16,false),sampleRate=(header[23]!<<16)|(header[24]!<<8)|header[25]!;
  if(chan!==0&&chan!==0xffff)throw containerRefusal(`AVR chan ${chan} is not implemented`,patchWelcome);
  const channels=chan?2:1;
  if(!sampleRate)throw containerRefusal('Invalid AVR sample rate',invalidData);
  const codec=avrPcmCodec(bps,sign);
  if(codec==='unmapped')throw containerRefusal(`AVR bps ${bps} and sign ${sign} are not implemented`,patchWelcome);
  if(codec===null)throw new AvrError('unsupported',`AVR bps ${bps} is not implemented`);
  const offset=BigInt(headerBytes),dataBytes=input.size-offset,blockAlign=bps/8*channels;
  if(dataBytes%BigInt(blockAlign))throw new AvrError('unsupported','AVR partial trailing sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'avr' as const,sign}),packets:raw.packets});
}
/** Registered by `export {avr} from './avr.js';` in registry.ts. Demux only, as native. */
export const avr=defineContainer({
  name:'avr',
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='2BIT'},headerBytes,open:(source,{maxReadBytes,signal})=>openAvr(source,{maxReadBytes,signal})}
});
