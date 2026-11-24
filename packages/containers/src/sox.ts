// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/soxdec.c, soxenc.c, sox.h and pcm.c (pinned FFmpeg 946fcce0). See NOTICE-SOX.
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {openRawPcm,muxRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput,RawPcmMuxOptions} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class SoxError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type SoxCodec='pcm_s32le'|'pcm_s32be';
export interface SoxInfo extends RawPcmInfo {readonly container:'sox';readonly headerSize:number;readonly declaredSamples:bigint}
export interface SoxInput extends Omit<RawPcmInput,'info'> {readonly info:SoxInfo}
export interface SoxOutputFormat {readonly codec:SoxCodec;readonly channels:number;readonly sampleRate:number}
/** SOX_FIXED_HDR plus the magic; the probe reads 28 bytes, as sox_probe inspects buf+4 and buf+24. */
const fixedHeader=28,headerBytes=fixedHeader+4,probeBytes=28,intMax=2147483647;
const magics:Readonly<Record<SoxCodec,readonly number[]>>={pcm_s32le:[0x2e,0x53,0x6f,0x58],pcm_s32be:[0x58,0x6f,0x53,0x2e]};
export function supportsSoxCodec(codec:string):codec is SoxCodec{return Object.hasOwn(magics,codec);}
function magicCodec(bytes:Uint8Array):SoxCodec|undefined{return (Object.keys(magics) as SoxCodec[]).find(codec=>magics[codec].every((value,index)=>bytes[index]===value));}
async function readExact(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new SoxError('invalid-data','Unexpected SoX header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** sox_probe after a magic head: nonzero header size and channel words in the zero-padded 28-byte probe buffer. */
export async function probeSox(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new SoxError('resource-limit','Invalid SoX probe budget');
  const bytes=new Uint8Array(probeBytes);bytes.set(await readExact(input,Number(input.size<BigInt(probeBytes)?input.size:BigInt(probeBytes)),maxReadBytes,signal));
  const view=new DataView(bytes.buffer);return magicCodec(bytes)!==undefined&&view.getUint32(4)!==0&&view.getUint32(24)!==0;
}
/** Finite range-backed SoX native: a 32-byte fixed header, padding to 4+header_size, then s32 PCM to EOF. Comments, the
 * header sample count's disagreement with EOF and other magics are not mirrored: comments and magics fail explicitly, and EOF wins as natively.
 * The file stores no layout: a null mask lets the backend guess the default layout under -guess_layout_max, as native does. */
export async function openSox(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<SoxInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new SoxError('resource-limit','Invalid SoX read budget');
  if(input.size<BigInt(headerBytes))throw new SoxError('invalid-data','Truncated SoX header');
  const header=await readExact(input,headerBytes,maxReadBytes,signal),codec=magicCodec(header);
  if(!codec)throw new SoxError('unsupported','Unsupported SoX magic');
  const little=codec==='pcm_s32le',view=new DataView(header.buffer),headerSize=view.getUint32(4,little),declaredSamples=view.getBigUint64(8,little),rate=view.getFloat64(16,little),channels=view.getInt32(24,little),commentSize=view.getUint32(28,little);
  if(commentSize>0xffffffff-fixedHeader-4)throw containerRefusal(`invalid SoX comment size (${commentSize})`,183);
  if(!(rate>0&&rate<=intMax))throw containerRefusal('invalid SoX sample rate',183);
  if(((headerSize+4)>>>0)%8!==0||headerSize<fixedHeader+commentSize||channels>65535||channels<=0)throw containerRefusal('invalid SoX header',183);
  if(commentSize>0)throw new SoxError('unsupported','SoX comment metadata is not implemented');
  const sampleRate=Math.trunc(rate);
  // Native truncates to 0 and its decoder refuses with EINVAL.
  if(sampleRate<1)throw containerRefusal('SoX sample rates below 1 Hz are not implemented',234);
  const offset=BigInt(headerSize)+4n;
  if(offset>input.size)throw new SoxError('invalid-data','SoX header exceeds input');
  const raw=await openRawPcm({size:input.size-offset,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'sox' as const,headerSize,declaredSamples}),packets:raw.packets});
}
function outputHeader(format:SoxOutputFormat,samples:bigint):Uint8Array{
  const {codec,channels,sampleRate}=format;
  if(!supportsSoxCodec(codec))throw new SoxError('unsupported','Unsupported SoX output codec');
  if(!Number.isInteger(channels)||channels<1||channels>65535||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>intMax||samples<0n||samples*BigInt(channels)>0xffffffffffffffffn)throw new SoxError('invalid-data','Invalid SoX output parameters');
  const little=codec==='pcm_s32le',bytes=new Uint8Array(headerBytes),view=new DataView(bytes.buffer);
  bytes.set(magics[codec]);view.setUint32(4,fixedHeader,little);view.setBigUint64(8,samples*BigInt(channels),little);view.setFloat64(16,sampleRate,little);view.setUint32(24,channels,little);view.setUint32(28,0,little);
  return bytes;
}
/** Validation available before opening an output transaction. */
export function validateSoxOutput(format:SoxOutputFormat,samples:bigint):void{outputHeader(format,samples);}
/** Known-size sequential SoX output: the sample-word count the seekable trailer patches is written up front. */
export async function muxSox(output:WriteHandle,format:SoxOutputFormat,packets:AsyncIterable<MediaPacket>,options:RawPcmMuxOptions):Promise<void>{
  let abortAttempted=false;
  try{
    const stable={...format},header=outputHeader(stable,options.sampleCount),{maxWriteBytes,signal}=options;
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new SoxError('resource-limit','Invalid SoX write budget');
    for(let offset=0;offset<header.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(header.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}
    await muxRawPcm({write:chunk=>output.write(chunk),commit:()=>output.commit(),async abort(reason){abortAttempted=true;await output.abort(reason);}},stable,packets,options);
  }catch(error){if(!abortAttempted)try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'SoX output and abort failed');}throw error;}
}
/** Registered by `export {sox} from './sox.js';` in registry.ts. Exact magics, so precedence 100; native writes comment metadata, so no dropsMetadata. */
export const sox=defineContainer({
  name:'sox',
  demux:{probe:{precedence:100,head:bytes=>magicCodec(bytes)!==undefined,confirm:probeSox},headerBytes,open:(source,{maxReadBytes,signal})=>openSox(source,{maxReadBytes,signal})},
  mux:{label:'SoX',extensions:['.sox'],defaultCodec:'pcm_s32le',supports:supportsSoxCodec,refuse:codec=>containerRefusal(`SoX muxer does not support ${codec}; use pcm_s32le or pcm_s32be`,234),scratchBytes:headerBytes,
    validate:({codec,channels,sampleRate,samples})=>validateSoxOutput({codec:codec as SoxCodec,channels,sampleRate},samples),
    write:(output,{codec,channels,sampleRate,samples},packets,{maxWriteBytes,signal})=>muxSox(output,{codec:codec as SoxCodec,channels,sampleRate},packets,{sampleCount:samples,maxWriteBytes,signal})}
});
