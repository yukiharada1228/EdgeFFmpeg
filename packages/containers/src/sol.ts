// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/sol.c and pcm.c (pinned FFmpeg 946fcce0). See NOTICE-SOL.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class SolError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type SolCodec='pcm_u8'|'pcm_s16le';
export interface SolInfo extends RawPcmInfo {readonly container:'sol';readonly codec:SolCodec;readonly magic:number;readonly type:number}
export interface SolInput extends Omit<RawPcmInput,'info'> {readonly info:SolInfo}
export interface SolOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal}
/** sol_read_packet: av_get_packet(pb,pkt,MAX_SIZE) with the CORRUPT flag cleared, so every packet but the last carries 4096 bytes. */
const headerBytes=14,probeBytes=6,maxPacketBytes=4096,oldMagic=0x0b8d,magics:readonly number[]=[oldMagic,0x0c0d,0x0c8d],dpcm=1,bits16=4,stereo=16;
/** sol_read_header returns a literal -1 on a bad tag, which the ffmpeg CLI reports as status 255 on every host. A zero rate fails when the decoder
 * or muxer opens with AVERROR(EINVAL): status 234 on Linux (EINVAL is 22 on Linux and macOS alike). */
const tagStatus=255,einval=234;
/** sol_codec_id and sol_channels: 'sol_dpcm' is native AV_CODEC_ID_SOL_DPCM, which the port does not decode. */
export function solStream(magic:number,type:number):{readonly codec:SolCodec|'sol_dpcm';readonly channels:1|2}{
  const codec=type&dpcm?'sol_dpcm':magic===oldMagic?'pcm_u8':type&bits16?'pcm_s16le':'pcm_u8';
  return {codec,channels:magic===oldMagic||!(type&stereo)?1:2};
}
/** sol_probe over the first six bytes: AV_RL32 truncated to 16 bits is one of the three magics, then "SOL\0". */
export function isSolHead(bytes:Uint8Array):boolean{
  if(bytes.length<4)return false;
  return magics.includes(bytes[0]!|bytes[1]!<<8)&&bytes[2]===0x53&&bytes[3]===0x4f&&(bytes.length<probeBytes||bytes[4]===0x4c&&bytes[5]===0);
}
async function readHead(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new SolError('invalid-data','Unexpected SOL header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** Finite range-backed SOL: u16le magic, "SOL\0", u16le rate, u8 type, u32 size (ignored), a padding byte unless the magic is 0x0B8D, then PCM to EOF. */
export async function openSol(input:ReadHandle,options:SolOptions):Promise<SolInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new SolError('resource-limit','Invalid SOL read budget');
  // avio reads past EOF as zeros, so the tag is checked over the zero-padded head before any truncation refusal.
  const head=new Uint8Array(headerBytes),filled=Number(input.size<BigInt(headerBytes)?input.size:BigInt(headerBytes));head.set(await readHead(input,filled,maxReadBytes,signal));
  const view=new DataView(head.buffer);
  if(view.getUint32(2,true)!==0x004c4f53)throw containerRefusal('Invalid SOL tag',tagStatus);
  const magic=view.getUint16(0,true),offset=magic===oldMagic?13:14;
  if(filled<offset)throw new SolError('unsupported','Truncated SOL header is not implemented');
  const sampleRate=view.getUint16(6,true),type=head[8]!,{codec,channels}=solStream(magic,type);
  if(codec==='sol_dpcm')throw new SolError('unsupported','SOL DPCM (sol_dpcm) decoding is not implemented');
  if(!sampleRate)throw containerRefusal('Invalid SOL sample rate: 0',einval);
  const dataOffset=BigInt(offset),dataBytes=input.size-dataOffset,blockAlign=(codec==='pcm_s16le'?2:1)*channels;
  if(dataBytes%BigInt(blockAlign))throw new SolError('unsupported','SOL partial trailing sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(dataOffset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,codec,dataOffset,container:'sol' as const,magic,type}),packets:raw.packets});
}
async function confirmSol(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(input.size<BigInt(probeBytes)||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)return false;
  return isSolHead(await readHead(input,probeBytes,maxReadBytes,signal));
}
/** Registered by `export {sol} from './sol.js';` in registry.ts. Demux only, as native has no sol muxer. */
export const sol=defineContainer({
  name:'sol',
  demux:{probe:{precedence:100,head:isSolHead,confirm:confirmSol},headerBytes,
    async open(source,{maxReadBytes,signal,seek}){if(seek>0n)throw containerRefusal('SOL input seeking is not implemented');return openSol(source,{maxReadBytes,signal});},
    packetSpan:(info:SolInfo)=>BigInt(maxPacketBytes/info.blockAlign)}
});
