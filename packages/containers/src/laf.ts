// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/lafdec.c (pinned FFmpeg 946fcce0), single-stream files only. See NOTICE-LAF.
import type {ReadHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import type {RawPcmInfo} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class LafError extends Error {constructor(readonly code:'invalid-data'|'resource-limit',message:string){super(message);}}
export type LafCodec='pcm_u8'|'pcm_s16le'|'pcm_f32le'|'pcm_s24le';
export interface LafInfo extends RawPcmInfo {readonly container:'laf';readonly codec:LafCodec;readonly quality:number;readonly mode:number;readonly vertical:number;readonly horizontal:number;readonly lfe:number;readonly blocks:bigint;readonly blockBytes:bigint;readonly droppedBytes:bigint}
export interface LafInput {readonly info:LafInfo;packets(startSample?:bigint,maxPacketBytes?:number):AsyncIterable<MediaPacket>}
/** LIMITLESS, HEAD, quality u8, mode u8, st_count rl32, per stream vertical/horizontal rl32 floats and lfe u8, rate rl32, duration rl64: 40 bytes for one stream. */
const magicBytes=13,fixedBytes=19,streamBytes=9,headerBytes=fixedBytes+streamBytes+12,invalidData=183,maxStreams=4096,int32Max=2147483647;
/** laf_read_header's quality switch: codec and bytes per sample. */
const qualities:readonly (readonly [LafCodec,number])[]=[['pcm_u8',1],['pcm_s16le',2],['pcm_f32le',4],['pcm_s24le',3]];
/** AV_CH_FRONT_LEFT, FRONT_RIGHT, FRONT_CENTER, LOW_FREQUENCY, SIDE_LEFT and SIDE_RIGHT; FC is AV_CHANNEL_LAYOUT_MONO. */
const FL=0x1,FR=0x2,FC=0x4,LFE=0x8,SL=0x200,SR=0x400;
/** laf_read_header's layout chain: float == compares, so -0.0 equals 0 and NaN matches nothing (mono). */
export function lafChannelMask(vertical:number,horizontal:number,lfe:number):number{
  if(lfe)return LFE;
  if(vertical===0){if(horizontal===0)return FC;if(horizontal===-30)return FL;if(horizontal===30)return FR;if(horizontal===-110)return SL;if(horizontal===110)return SR;}
  return FC;
}
async function readExact(input:ReadHandle,offset:bigint,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(offset+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new LafError('invalid-data','Unexpected LAF read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
const isMagic=(bytes:Uint8Array)=>String.fromCharCode(...bytes.subarray(0,magicBytes))==='LIMITLESSHEAD';
/** laf_probe: "LIMITLESS" then "HEAD"; reads exactly the 13 bytes it compares. */
export async function probeLaf(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new LafError('resource-limit','Invalid LAF read budget');
  if(input.size<BigInt(magicBytes))return false;
  return isMagic(await readExact(input,0n,magicBytes,maxReadBytes,signal));
}
/** Finite range-backed single-stream LAF. Every block is one stored-bitmask byte then rate*bpp sample bytes; each bitmask is checked with a one-byte bounded read before any sample is returned. */
export async function openLaf(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<LafInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new LafError('resource-limit','Invalid LAF read budget');
  // Native read_header fails with INVALIDDATA on each of these, in this order; a header cut short reads as zeros and then fails avio_feof (also INVALIDDATA).
  const fixedEnd=input.size<BigInt(fixedBytes)?Number(input.size):fixedBytes,fixed=new Uint8Array(fixedBytes);fixed.set(await readExact(input,0n,fixedEnd,maxReadBytes,signal));
  if(String.fromCharCode(...fixed.subarray(9,13))!=='HEAD')throw containerRefusal('Invalid LAF header',invalidData);
  const view=new DataView(fixed.buffer),quality=fixed[13]!,mode=fixed[14]!,streams=view.getUint32(15,true);
  if(quality>3)throw containerRefusal(`Invalid LAF quality: ${quality}`,invalidData);
  if(mode>1)throw containerRefusal(`Invalid LAF mode: ${mode}`,invalidData);
  if(streams===0||streams>maxStreams)throw containerRefusal(`Invalid LAF stream count: ${streams}`,invalidData);
  // Native exposes one mono stream per LAF channel and the CLI maps only one of them; that selection is not mirrored.
  if(streams>1)throw containerRefusal(`LAF files with ${streams} streams are not implemented`);
  if(input.size<BigInt(headerBytes))throw containerRefusal('Truncated LAF header',invalidData);
  const rest=await readExact(input,BigInt(fixedBytes),headerBytes-fixedBytes,maxReadBytes,signal),restView=new DataView(rest.buffer);
  const vertical=restView.getFloat32(0,true),horizontal=restView.getFloat32(4,true),lfe=rest[8]!,sampleRate=restView.getUint32(9,true);
  const [codec,bpp]=qualities[quality]!,blockAlign=bpp,samples=BigInt(bpp)*BigInt(sampleRate);
  // (int64)bpp * st_count * sample_rate must be nonzero and below INT32_MAX; the header duration (rl64 / st_count) is not used for packets.
  if(samples===0n||samples>=BigInt(int32Max))throw containerRefusal(`Invalid LAF sample rate: ${sampleRate}`,invalidData);
  const blockBytes=1n+samples,dataBytes=input.size-BigInt(headerBytes),blocks=dataBytes/blockBytes,droppedBytes=dataBytes%blockBytes;
  // ffio_read_size fails on a short final block, so native drops it; a zero bitmask (nb_stored 0) is a demux error instead and is refused, even in that tail.
  for(let block=0n;block<blocks+(droppedBytes?1n:0n);block++){
    const offset=BigInt(headerBytes)+block*blockBytes,mask=(await readExact(input,offset,1,maxReadBytes,signal))[0]!;
    if(!(mask&1))throw new LafError('invalid-data',`Invalid LAF stored bitmask at ${offset}`);
  }
  // Every position is a native-order single-channel layout (FC is AV_CHANNEL_LAYOUT_MONO), so -guess_layout_max never drops it: report the mask, never null.
  const channelMask=lafChannelMask(vertical,horizontal,lfe);
  const info:LafInfo=Object.freeze({container:'laf' as const,codec,channels:1,sampleRate,channelMask,bitsPerSample:bpp*8,blockAlign,dataOffset:BigInt(headerBytes),dataBytes:blocks*samples,durationSamples:blocks*BigInt(sampleRate),quality,mode,vertical,horizontal,lfe,blocks,blockBytes,droppedBytes});
  const timeBase=Object.freeze({num:1n,den:BigInt(sampleRate)}),span=BigInt(sampleRate);
  return Object.freeze({info,
    async *packets(startSample=0n,maxPacketBytes=maxReadBytes):AsyncIterable<MediaPacket>{
      signal?.throwIfAborted();
      if(startSample<0n||startSample>info.durationSamples)throw new LafError('invalid-data','LAF seek outside input');
      if(!Number.isSafeInteger(maxPacketBytes)||maxPacketBytes<blockAlign)throw new LafError('resource-limit','Invalid LAF packet budget');
      const maxSamples=BigInt(Math.floor(maxPacketBytes/blockAlign));
      for(let block=startSample/span,from=startSample%span;block<blocks;block++,from=0n){
        const base=BigInt(headerBytes)+block*blockBytes+1n;
        for(let first=from;first<span;first+=maxSamples){
          signal?.throwIfAborted();const count=span-first<maxSamples?span-first:maxSamples,pts=block*span+first;
          const data=await readExact(input,base+first*BigInt(blockAlign),Number(count)*blockAlign,maxReadBytes,signal);
          yield {streamIndex:0,data,pts,dts:pts,duration:count,timeBase,flags:1};
        }
      }
    }
  });
}
/** Registered by `export {laf} from './laf.js';` in registry.ts. Demux only; native packets hold one block (rate samples). */
export const laf=defineContainer({
  name:'laf',
  // Exact head "LIMI"; the confirm reads the 13 bytes laf_probe compares ("LIMITLESS" + "HEAD").
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='LIMI',confirm:probeLaf},headerBytes:128,
    // laf_read_seek returns -1, so native input -ss falls back to the generic index; it is not mirrored.
    async open(source,{maxReadBytes,signal,seek}){if(seek>0n)throw containerRefusal('LAF input seeking is not implemented');return openLaf(source,{maxReadBytes,signal});},packetSpan:(info:LafInfo)=>BigInt(info.sampleRate)}
});
