// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/sdxdec.c and pcm.c ff_pcm_read_packet (pinned FFmpeg 946fcce0). See NOTICE-SDX.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class SdxError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type SdxCodec='pcm_u8'|'pcm_u16le'|'pcm_u24le'|'pcm_u32le';
export interface SdxInfo extends RawPcmInfo {readonly container:'sdx';readonly codec:SdxCodec;readonly bitDepth:number;readonly nameBytes:number;readonly copyRefusal:string}
export interface SdxInput extends Omit<RawPcmInput,'info'> {readonly info:SdxInfo}
export interface SdxOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal}
/** Header bytes held while open: one 0x1a scan window, then the 2-byte version/length and 5-byte depth/rate reads. */
const headerBytes=128,scanWindow=64,intMax=2147483647;
/** sdx_read_header's depth switch: unsigned little-endian PCM of depth/8 bytes. */
const codecs:Readonly<Record<number,SdxCodec>>={8:'pcm_u8',16:'pcm_u16le',24:'pcm_u24le',32:'pcm_u32le'};
export function sdxCodec(depth:number):SdxCodec|null{return Object.hasOwn(codecs,depth)?codecs[depth]!:null;}
/** AVERROR_INVALIDDATA from read_header (exit 183), raised before any output exists. */
const invalid=(what:string):never=>{throw containerRefusal(`Invalid data found when processing input: SDX ${what}`,183);};
async function readExact(input:ReadHandle,offset:bigint,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(offset+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new SdxError('invalid-data','Unexpected SDX header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** avio_skip(4), then avio_r8 until 0x1a or EOF, in bounded windows; returns the 0x1a offset, or null at EOF. Each window holds at most 64 bytes, so it may overlap the rest of the header. */
export async function scanSdxMarker(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<bigint|null>{
  for(let position=4n;position<input.size;){
    const remaining=input.size-position,length=Number(remaining<BigInt(Math.min(maxReadBytes,scanWindow))?remaining:BigInt(Math.min(maxReadBytes,scanWindow)));
    const window=await readExact(input,position,length,maxReadBytes,signal),index=window.indexOf(0x1a);
    if(index>=0)return position+BigInt(index);position+=BigInt(length);
  }
  return null;
}
/** mov_probe reads an atom type at byte 4 of every file (the 'SDX:' size field runs past the probe buffer): these score 50 or more, so native's mov probe
 * outscores sdx_probe's 50 (or ties it at 50, which detects nothing) and the file is not sdx; ftyp with a jp2/jxl brand scores 5 and stays sdx. */
const movTags=new Set(['moov','mdat','pnot','udta','ftyp','ediw','wide','free','junk','pict','skip','uuid','prfl']),confirmBytes=12;
/** Undeclared detection: false where native's mov probe claims the head (bytes past EOF read as native's zero probe padding). */
export async function confirmSdx(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new SdxError('resource-limit','Invalid SDX read budget');
  // mov_probe stops before reading a tag when fewer than 8 bytes exist.
  if(input.size<8n)return true;
  const bytes=new Uint8Array(confirmBytes);bytes.set(await readExact(input,0n,input.size<BigInt(confirmBytes)?Number(input.size):confirmBytes,maxReadBytes,signal));
  const tag=String.fromCharCode(...bytes.subarray(4,8)),brand=String.fromCharCode(...bytes.subarray(8,12));
  return !movTags.has(tag)||tag==='ftyp'&&(brand==='jp2 '||brand==='jxl ');
}
/** Finite range-backed SDX: 'SDX:', bytes up to 0x1a, version 1, name length and name, 4 skipped, depth, RL32 rate, 16 skipped, then unsigned PCM to EOF. */
export async function openSdx(input:ReadHandle,options:SdxOptions):Promise<SdxInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new SdxError('resource-limit','Invalid SDX read budget');
  // avio_r8 returns 0 at EOF: a missing 0x1a, version byte or depth byte all fail read_header with INVALIDDATA.
  const marker=await scanSdxMarker(input,maxReadBytes,signal);if(marker===null)invalid('header marker');
  const after=marker!+1n,fields=input.size>after?await readExact(input,after,Number(input.size-after<2n?input.size-after:2n),maxReadBytes,signal):new Uint8Array(0);
  if(fields[0]!==1)invalid('header version');
  const nameBytes=fields[1]??0,depthAt=after+2n+BigInt(nameBytes)+4n;
  if(input.size<=depthAt)invalid('bit depth');
  const dataOffset=depthAt+1n+4n+16n;
  if(input.size<dataOffset)throw new SdxError('unsupported','Truncated SDX header is not implemented');
  const tail=await readExact(input,depthAt,5,maxReadBytes,signal),bitDepth=tail[0]!,codec=sdxCodec(bitDepth);
  if(!codec)invalid(`bit depth ${bitDepth}`);
  const sampleRate=new DataView(tail.buffer).getUint32(1,true);
  // codecpar->sample_rate is an int: RL32 values above INT_MAX turn negative. Native opens such files and its decoder then fails with EINVAL (exit 234); copy is not mirrored.
  if(sampleRate<1||sampleRate>intMax)throw containerRefusal(`SDX sample rate ${sampleRate} is not implemented`,234);
  const blockAlign=bitDepth/8,dataBytes=input.size-dataOffset;
  // With no packet the decoder never opens, so native's decoded framecrc keeps the stream's 1/90000 time base in its header.
  if(dataBytes===0n)throw new SdxError('unsupported','Empty SDX sample data is not implemented');
  if(dataBytes%BigInt(blockAlign)!==0n)throw new SdxError('unsupported','Partial trailing SDX sample is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(dataOffset+position,length,abort)},{codec:codec!,channels:1,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,codec:codec!,dataOffset,container:'sdx' as const,bitDepth,nameBytes,
    // sdx sets no pts info, so native packets keep avformat_new_stream's 1/90000 time base; copy output is not mirrored.
    copyRefusal:'SDX stream copy is not implemented: native packets use a 1/90000 time base'}),packets:raw.packets});
}
/** Registered by `export {sdx} from './sdx.js';` in registry.ts. Demux only, as native has no sdx muxer. */
export const sdx=defineContainer({
  name:'sdx',
  // Exact head 'SDX:' (sdx_probe's AV_RB32(buf) == AV_RB32("SDX:"), score 50); no other registered format claims it. The confirm leaves the heads native's mov probe claims.
  demux:{probe:{precedence:100,head:bytes=>bytes[0]===0x53&&bytes[1]===0x44&&bytes[2]===0x58&&bytes[3]===0x3a,confirm:confirmSdx},headerBytes,
    // Native input -ss seeks through ff_pcm_read_seek in 1/90000 units; it is not mirrored.
    async open(source,{maxReadBytes,signal,seek}){if(seek>0n)throw containerRefusal('SDX input seeking is not implemented');return openSdx(source,{maxReadBytes,signal});}}
});
