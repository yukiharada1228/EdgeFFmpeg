// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/epafdec.c and pcm.c (pinned FFmpeg 946fcce0). See NOTICE-EPAF.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class EpafError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type EpafCodec='pcm_s16le'|'pcm_s16be'|'pcm_s8';
export interface EpafInfo extends RawPcmInfo {readonly container:'epaf';readonly littleEndian:boolean}
export interface EpafInput extends Omit<RawPcmInput,'info'> {readonly info:EpafInfo}
/** Native reads five words after the magic, then skips to the fixed 2048-byte data offset. */
const fieldBytes=24,dataOffset=2048,maxChannels=512,invalid=183;
/** epaf_probe inspects bytes 0..23: 'fap ' with LE word 1 at 8, or ' paf' with word 0 at 8; zero word at 4; non-zero words at 12 and 20. */
export function probeEpaf(bytes:Uint8Array):boolean{
  if(bytes.length<fieldBytes)return false;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),magic=String.fromCharCode(...bytes.subarray(0,4)),word=(offset:number)=>view.getUint32(offset,true);
  return (magic==='fap '&&word(8)===1||magic===' paf'&&word(8)===0)&&word(4)===0&&word(12)!==0&&word(20)!==0;
}
async function read(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new EpafError('invalid-data','Unexpected EPAF header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** Finite range-backed EPAF: epaf_read_header field checks with native INVALIDDATA status, then PCM from byte 2048 to EOF. */
export async function openEpaf(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<EpafInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new EpafError('resource-limit','Invalid EPAF read budget');
  // Native reads zero words past EOF and then fails its 2024-byte skip, so every file shorter than the data offset is INVALIDDATA.
  if(input.size<BigInt(dataOffset))throw containerRefusal('Truncated EPAF header',invalid);
  const view=new DataView((await read(input,fieldBytes,maxReadBytes,signal)).buffer);
  if(view.getUint32(4,true)!==0)throw containerRefusal('Invalid EPAF header word',invalid);
  const le=view.getUint32(8,true);
  if(le!==0&&le!==1)throw containerRefusal('Invalid EPAF byte order',invalid);
  const littleEndian=le===1,sampleRate=view.getInt32(12,littleEndian),tag=view.getInt32(16,littleEndian),channels=view.getInt32(20,littleEndian);
  if(channels<=0||channels>maxChannels||sampleRate<=0)throw containerRefusal('Invalid EPAF channels or sample rate',invalid);
  const codec:EpafCodec|undefined=tag===0?(littleEndian?'pcm_s16le':'pcm_s16be'):tag===2?'pcm_s8':undefined;
  if(!codec)throw containerRefusal(tag===1?'24-bit Paris PCM format is not supported':`Unsupported EPAF codec: ${tag}`,invalid);
  const offset=BigInt(dataOffset),dataBytes=input.size-offset,blockAlign=(codec==='pcm_s8'?1:2)*channels;
  if(dataBytes%BigInt(blockAlign)!==0n)throw new EpafError('unsupported','Partial trailing EPAF sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'epaf' as const,littleEndian}),packets:raw.packets});
}
/** Registered by `export {epaf} from './epaf.js';` in registry.ts. Demux only; native has no EPAF muxer. */
export const epaf=defineContainer({
  name:'epaf',
  // Exact magics no other format's head matches, so precedence 100; confirm reads exactly the 24 bytes epaf_probe reads.
  demux:{probe:{precedence:100,head:bytes=>{const magic=String.fromCharCode(...bytes);return magic==='fap '||magic===' paf';},
    async confirm(input,maxReadBytes,signal){return input.size>=BigInt(fieldBytes)&&probeEpaf(await read(input,fieldBytes,maxReadBytes,signal));}},
    headerBytes:fieldBytes,open:(source,{maxReadBytes,signal})=>openEpaf(source,{maxReadBytes,signal})}
});
