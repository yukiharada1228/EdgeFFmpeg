// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/sdsdec.c (pinned FFmpeg 946fcce0). See NOTICE-SDS.
import type {ReadHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import type {RawPcmInfo} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class SdsError extends Error {constructor(readonly code:'invalid-data'|'resource-limit',message:string){super(message);}}
export interface SdsInfo extends RawPcmInfo {readonly container:'sds';readonly bitDepth:number;readonly samplePeriod:number;readonly packetSamples:number;readonly blocks:bigint}
export interface SdsInput {readonly info:SdsInfo;packets(startSample?:bigint,maxPacketBytes?:number):AsyncIterable<MediaPacket>}
/** Header: F0 7E ch 01 nn nn depth period(3x7 bits) ... F7 (21 bytes); each data packet: F0 7E ch 02 nn, 120 data bytes, checksum, F7. */
const headerBytes=21,blockBytes=127,payloadOffset=5,payloadBytes=120;
/** byte2_read/byte3_read/byte4_read: 7-bit bytes left-justified into 32-bit words, 60, 40 or 30 per packet. */
export function unpackSdsBlock(src:Uint8Array,width:2|3|4):Uint8Array{
  if(src.length!==payloadBytes)throw new SdsError('invalid-data','Invalid SDS data packet length');
  const count=payloadBytes/width,out=new Uint8Array(count*4),view=new DataView(out.buffer);
  // byte2_read adds its two shifted bytes while byte3/4_read OR them; they differ only for 8-bit payload bytes, which native still accepts.
  for(let i=0,j=0;j<count;i+=width,j++){let sample=0;if(width===2)sample=(src[i]!<<25)+(src[i+1]!<<18);else for(let k=0;k<width;k++)sample|=src[i+k]!<<(25-7*k);view.setUint32(j*4,sample>>>0,true);}
  return out;
}
/** sds_read_header's width choice: depth 8..13 two bytes, 14..20 three, 21..28 four. */
export function sdsSampleWidth(bitDepth:number):2|3|4{
  if(!Number.isInteger(bitDepth)||bitDepth<8||bitDepth>28)throw new SdsError('invalid-data',`Invalid SDS bit depth: ${bitDepth}`);
  return bitDepth<14?2:bitDepth<21?3:4;
}
/** SDS_3BYTE_TO_INT_DECODE of the little-endian 24-bit period, then integer 1e9/period, 16000 for period 0. */
export function sdsSampleRate(period:number):number{return period?Math.floor(1000000000/period):16000;}
export function sdsSamplePeriod(bytes:Uint8Array):number{return (bytes[0]!&0x7f)|((bytes[1]!&0x7f)<<7)|((bytes[2]!&0x7f)<<14);}
async function readExact(input:ReadHandle,offset:bigint,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(offset+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new SdsError('invalid-data','Unexpected SDS read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** sds_probe: F0 7E xx 01, depth 8..28 at byte 6 and F7 at byte 20; reads exactly the 21 bytes native inspects. */
export async function probeSds(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new SdsError('resource-limit','Invalid SDS read budget');
  if(input.size<BigInt(headerBytes))return false;
  const head=await readExact(input,0n,headerBytes,maxReadBytes,signal);
  return head[0]===0xf0&&head[1]===0x7e&&head[3]===0x01&&head[20]===0xf7&&head[6]!>=8&&head[6]!<=28;
}
/** Finite range-backed SDS. Every packet's F0 7E and F7 framing and the whole-packet size are checked with bounded reads before any sample is returned. */
export async function openSds(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<SdsInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new SdsError('resource-limit','Invalid SDS read budget');
  if(input.size<BigInt(headerBytes))throw new SdsError('invalid-data','Truncated SDS header');
  // Native read_header checks only the bit depth; the probe alone tests the magic and the closing F7.
  const header=await readExact(input,0n,headerBytes,maxReadBytes,signal),bitDepth=header[6]!,width=sdsSampleWidth(bitDepth);
  const samplePeriod=sdsSamplePeriod(header.subarray(7,10)),sampleRate=sdsSampleRate(samplePeriod),packetSamples=payloadBytes/width;
  const dataBytes=input.size-BigInt(headerBytes),blocks=dataBytes/BigInt(blockBytes);
  if(dataBytes%BigInt(blockBytes))throw new SdsError('invalid-data','Truncated SDS data packet');
  // Native sds_read_packet fails mid-stream on these; refuse them up front instead. Windows cover only the checked bytes.
  let windowStart=0n,window:Uint8Array=new Uint8Array(0);
  const at=async(position:bigint)=>{
    if(position<windowStart||position>=windowStart+BigInt(window.length)){const remaining=input.size-position;window=await readExact(input,position,Number(remaining<BigInt(maxReadBytes)?remaining:BigInt(maxReadBytes)),maxReadBytes,signal);windowStart=position;}
    return window[Number(position-windowStart)]!;
  };
  for(let block=0n;block<blocks;block++){
    const base=BigInt(headerBytes)+block*BigInt(blockBytes);
    if(await at(base)!==0xf0||await at(base+1n)!==0x7e)throw new SdsError('invalid-data',`Invalid SDS data packet header at ${base}`);
    if(await at(base+BigInt(blockBytes-1))!==0xf7)throw new SdsError('invalid-data',`Missing SDS data packet end at ${base}`);
  }
  const info:SdsInfo=Object.freeze({container:'sds' as const,codec:'pcm_u32le' as const,channels:1,sampleRate,channelMask:null,bitsPerSample:32,blockAlign:4,dataOffset:BigInt(headerBytes),dataBytes,durationSamples:blocks*BigInt(packetSamples),bitDepth,samplePeriod,packetSamples,blocks});
  const timeBase=Object.freeze({num:1n,den:BigInt(sampleRate)}),span=BigInt(packetSamples);
  return Object.freeze({info,
    async *packets(startSample=0n,maxPacketBytes=maxReadBytes):AsyncIterable<MediaPacket>{
      signal?.throwIfAborted();
      if(startSample<0n||startSample>info.durationSamples)throw new SdsError('invalid-data','SDS seek outside input');
      if(!Number.isSafeInteger(maxPacketBytes)||maxPacketBytes<4)throw new SdsError('resource-limit','Invalid SDS packet budget');
      const maxSamples=Math.floor(maxPacketBytes/4);
      for(let block=startSample/span,from=Number(startSample%span);block<blocks;block++,from=0){
        const samples=unpackSdsBlock(await readExact(input,BigInt(headerBytes+payloadOffset)+block*BigInt(blockBytes),payloadBytes,maxReadBytes,signal),width);
        for(let first=from;first<packetSamples;first+=maxSamples){
          signal?.throwIfAborted();const count=Math.min(maxSamples,packetSamples-first),pts=block*span+BigInt(first);
          yield {streamIndex:0,data:samples.slice(first*4,(first+count)*4),pts,dts:pts,duration:BigInt(count),timeBase,flags:1};
        }
      }
    }
  });
}
/** Registered by `export {sds} from './sds.js';` in registry.ts. Demux only; native packets hold one SDS data packet (60, 40 or 30 samples). */
export const sds=defineContainer({
  name:'sds',
  // Exact head F0 7E xx 01; the confirm reads the 21 bytes sds_probe inspects.
  demux:{probe:{precedence:100,head:bytes=>bytes[0]===0xf0&&bytes[1]===0x7e&&bytes[3]===0x01,confirm:probeSds},headerBytes:128,
    // Native input -ss goes through the generic index and ends in a demux error with shifted timestamps; it is not mirrored.
    async open(source,{maxReadBytes,signal,seek}){if(seek>0n)throw containerRefusal('SDS input seeking is not implemented');return openSds(source,{maxReadBytes,signal});},packetSpan:(info:SdsInfo)=>BigInt(info.packetSamples)}
});
