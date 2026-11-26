// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/nspdec.c and pcm.c (pinned FFmpeg 946fcce0). See NOTICE-NSP.
import type {ReadHandle} from '@edge-ffmpeg/core';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class NspError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface NspInfo extends RawPcmInfo {readonly container:'nsp';readonly metadata:boolean;readonly copyRefusal:string;readonly warnings:readonly string[]}
export interface NspInput extends Omit<RawPcmInput,'info'> {readonly info:NspInfo}
export interface NspOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal;
  /** Input -ss in microseconds; any positive seek is refused. */
  readonly seek?:bigint}
/** Native skips the 12-byte FORM/DS16 head; chunks are {RB32 id, RL32 size}; nsp_read_header returns AVERROR_INVALIDDATA (183) for a short HEDR/HDR8.
 * A walk without audio opens a zero-channel stream and a rate outside 1..INT_MAX fails the decoder: both end with the Linux AVERROR(EINVAL) status 234. */
const skip=12n,noteWindow=1024,invalidData=183,invalidArgument=234,int32=0x7fffffff,noData='NSP input ends before a data chunk';
const id=(text:string)=>((text.charCodeAt(0)<<24)|(text.charCodeAt(1)<<16)|(text.charCodeAt(2)<<8)|text.charCodeAt(3))>>>0;
const hedr=new Set([id('HEDR'),id('HDR8')]),note=id('NOTE'),stereo=id('SDAB'),mono=new Set([id('SDA_'),id('SD_A')]),warned=new Set(['SD_2','SD_3','SD_4','SD_5','SD_6','SD_7','SD_8'].map(id));
const copyRefusal='NSP stream copy is not implemented: native sets no pts info, so copy timestamps use a 1/90000 time base';
async function read(input:ReadHandle,position:bigint,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(position+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new NspError('invalid-data','Unexpected NSP header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** nsp_probe: 'FORM' at 0 and 'DS16' at 4 (an AIFF FORM carries its size at 4, so the checks are disjoint). */
export function probeNsp(bytes:Uint8Array):boolean{return bytes.length>=8&&String.fromCharCode(...bytes.subarray(0,8))==='FORMDS16';}
/** avio_get_str(pb,size,...): bytes consumed, stopping after the first NUL; native reads a NUL at EOF, so a note that overruns EOF ends there. */
async function noteLength(input:ReadHandle,position:bigint,size:number,maxReadBytes:number,signal?:AbortSignal):Promise<bigint>{
  let consumed=0;
  while(consumed<size){
    const available=input.size-position-BigInt(consumed);if(available<=0n)return BigInt(consumed);
    const want=Math.min(size-consumed,noteWindow,maxReadBytes),length=available<BigInt(want)?Number(available):want,window=await read(input,position+BigInt(consumed),length,maxReadBytes,signal),nul=window.indexOf(0);
    if(nul>=0)return BigInt(consumed+nul+1);
    consumed+=length;
  }
  return BigInt(size);
}
/** Finite range-backed NSP: the nsp_read_header chunk walk, then s16le PCM from the first audio chunk header to EOF. */
export async function openNsp(input:ReadHandle,options:NspOptions):Promise<NspInput>{
  const {maxReadBytes,signal,seek=0n}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new NspError('resource-limit','Invalid NSP read budget');
  let position=skip,sampleRate=0,channels=0,metadata=false;const warnings:string[]=[];
  while(!channels){
    const left=input.size-position;
    // Native reads zero words past EOF, so a chunk walk that runs out of bytes never finds audio and opens a zero-channel stream.
    if(left<=0n)throw containerRefusal(noData,invalidArgument);
    if(left<8n){
      const tail=await read(input,position,Number(left),maxReadBytes,signal);
      if(tail.length>=4){const chunk=new DataView(tail.buffer).getUint32(0,false);if(chunk===stereo||mono.has(chunk)||warned.has(chunk))throw new NspError('unsupported','Truncated NSP data chunk header is not implemented');}
      throw containerRefusal(noData,invalidArgument);
    }
    const header=new DataView((await read(input,position,8,maxReadBytes,signal)).buffer),chunk=header.getUint32(0,false),size=header.getUint32(4,true);position+=8n;
    if(hedr.has(chunk)){
      if(size<32)throw containerRefusal('Invalid NSP header chunk size',invalidData);
      if(input.size-position<24n)throw containerRefusal(noData,invalidArgument);
      sampleRate=new DataView((await read(input,position+20n,4,maxReadBytes,signal)).buffer).getUint32(0,true);position+=BigInt(size);
    }else if(chunk===note){
      // avio_get_str takes an int length: a size above INT_MAX reads nothing and is not mirrored.
      if(size>int32)throw new NspError('unsupported','NSP note larger than 2 GiB is not implemented');
      metadata=true;position+=await noteLength(input,position,size,maxReadBytes,signal)+BigInt(size&1);
    }else if(chunk===stereo)channels=2;
    else if(mono.has(chunk))channels=1;
    else if(warned.has(chunk)){channels=1;warnings.push('Unsupported chunk!');}
    // Any other id is not skipped: native reads the next chunk header right after this one.
  }
  if(sampleRate<1||sampleRate>int32)throw containerRefusal(`Invalid NSP sample rate: ${sampleRate|0}`,invalidArgument);
  if(seek>0n)throw new NspError('unsupported','NSP input seek is not implemented');
  const offset=position,dataBytes=input.size-offset,blockAlign=2*channels;
  // With no packet native keeps the 1/90000 stream time base, which a zero-sample framecrc header prints.
  if(dataBytes===0n)throw new NspError('unsupported','Empty NSP audio data is not implemented');
  if(dataBytes%BigInt(blockAlign))throw new NspError('unsupported','Partial trailing NSP sample frame is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(at,length,abort)=>input.readAt(offset+at,length,abort)},{codec:'pcm_s16le',channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'nsp' as const,metadata,copyRefusal,warnings:Object.freeze(warnings)}),packets:raw.packets});
}
/** Registered by `export {nsp} from './nsp.js';` in registry.ts. Demux only, as native. */
export const nsp=defineContainer({
  name:'nsp',
  // The 'FORM' head overlaps aiff (30) and iff (26), so nsp runs first at 24; confirm reads the 8 bytes nsp_probe inspects and is false for AIFF/AIFC, MAUD and a bare 4-byte FORM.
  demux:{probe:{precedence:24,head:bytes=>String.fromCharCode(...bytes)==='FORM',
    async confirm(input,maxReadBytes,signal){return input.size>=8n&&probeNsp(await read(input,0n,8,maxReadBytes,signal));}},
    headerBytes:noteWindow,open:(source,{maxReadBytes,signal,seek})=>openNsp(source,{maxReadBytes,signal,seek})}
});
