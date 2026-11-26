// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/iff.c, MAUD audio only (pinned FFmpeg 946fcce0). See NOTICE-IFF.
import type {ReadHandle} from '@edge-ffmpeg/core';
import type {PcmCodec} from '@edge-ffmpeg/avutil';
import {openRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
class IffError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type IffCodec='pcm_u8'|'pcm_s16be'|'pcm_alaw'|'pcm_mulaw';
export interface IffOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal;
  /** Input -ss in microseconds; a nonzero seek is refused (AVFMT_GENERIC_INDEX seeking is not mirrored). */
  readonly seek?:bigint}
export interface IffInfo extends RawPcmInfo {readonly container:'iff';
  /** MHDR fields as native reads them: bits RB16 at 4, rate numerator RB32 at 8, denominator RB16 at 12, compression RB16 at 18. */
  readonly bits:number;readonly compression:number;readonly rateNum:number;readonly rateDen:number;
  readonly metadata:boolean}
export interface IffInput extends Omit<RawPcmInput,'info'> {readonly info:IffInfo}
/** iff_read_header's MAUD codec choice by (maud_bits, maud_compression). */
const codecs:readonly (readonly [number,number,IffCodec])[]=[[8,0,'pcm_u8'],[16,0,'pcm_s16be'],[8,2,'pcm_alaw'],[8,3,'pcm_mulaw']];
/** Chunks iff_read_header turns into metadata (ANNO/TEXT comment, AUTH artist, (c) copyright, NAME title). */
const metadataChunks=new Set(['ANNO','TEXT','AUTH','(c) ','NAME']);
/** Every other chunk iff_read_header interprets: 8SVX, DSD, ILBM/ANIM video and PROP/COMT/DIIN/FVER paths, none mirrored. */
const foreignChunks=new Set(['VHDR','ABIT','BODY','DBOD','DSD ','DST ','CAMG','CMAP','BMHD','ANHD','DPAN','DPEL','DGBL','DLOC','TVDC','SXHD','FVER','DIIN','PROP','COMT']);
/** MHDR 1/2 channels and every CHAN override set AV_CHANNEL_LAYOUT_MONO/STEREO (native order, never guessed); 3 or more stay AV_CHANNEL_ORDER_UNSPEC. */
const monoMask=0x4,stereoMask=0x3,formHeader=12,chunkHeader=8,mhdrFields=20,headerBytes=32,packetSamples=1024n*8n,saneChannels=512,invalidData=183,patchWelcome=176;
interface Mhdr {readonly bits:number;readonly rateNum:number;readonly rateDen:number;readonly channels:number;readonly compression:number}
const tag=(bytes:Uint8Array,offset:number)=>String.fromCharCode(bytes[offset]!,bytes[offset+1]!,bytes[offset+2]!,bytes[offset+3]!);
async function readAt(input:ReadHandle,position:bigint,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length);let filled=0;
  while(filled<length){signal?.throwIfAborted();const requested=Math.min(length-filled,maxReadBytes),chunk=await input.readAt(position+BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new IffError('invalid-data','Unexpected IFF header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** iff_probe restricted to FORM...MAUD: reads 12 bytes, false on shorter input (native's zero padding fails too). */
export async function probeIff(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new IffError('resource-limit','Invalid IFF read budget');
  if(input.size<BigInt(formHeader))return false;
  // nsp_probe also scores 100 on 'DS16' at byte 4; native's tie leaves the format undetected (183), so that head is not claimed.
  const bytes=await readAt(input,0n,formHeader,maxReadBytes,signal);return tag(bytes,0)==='FORM'&&tag(bytes,8)==='MAUD'&&tag(bytes,4)!=='DS16';
}
/** Finite range-backed IFF MAUD: the chunk walk of iff_read_header to EOF, reading only chunk headers and the MHDR/CHAN fields, then PCM from MDAT. */
export async function openIff(input:ReadHandle,options:IffOptions):Promise<IffInput>{
  const {maxReadBytes,signal,seek=0n}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new IffError('resource-limit','Invalid IFF read budget');
  if(input.size<BigInt(formHeader))throw new IffError('unsupported','IFF input shorter than its FORM header is not implemented');
  const form=await readAt(input,0n,formHeader,maxReadBytes,signal),kind=tag(form,0),type=tag(form,8);
  if(kind!=='FORM')throw new IffError('unsupported',`IFF ${kind==='FRM8'?'FRM8 (DSD)':'non-FORM'} input is not implemented`);
  if(type!=='MAUD')throw new IffError('unsupported',`IFF FORM type ${JSON.stringify(type)} is not implemented (MAUD only)`);
  let position=BigInt(formHeader),header:Mhdr|null=null,body:{start:bigint;end:bigint}|null=null,metadata=false;
  while(position<input.size){
    signal?.throwIfAborted();
    if(input.size-position<BigInt(chunkHeader))throw new IffError('unsupported','IFF trailing partial chunk header is not implemented');
    const head=await readAt(input,position,chunkHeader,maxReadBytes,signal),id=tag(head,0),size=BigInt(new DataView(head.buffer).getUint32(4,false)),start=position+BigInt(chunkHeader),end=start+size;
    if(end>input.size)throw new IffError('unsupported',id==='MDAT'?'IFF MDAT chunk beyond EOF is not implemented':`IFF ${JSON.stringify(id)} chunk beyond EOF is not implemented`);
    if(id==='MHDR'){
      if(size<32n)throw containerRefusal('Invalid IFF MHDR chunk size',invalidData);
      const view=new DataView((await readAt(input,start,mhdrFields,maxReadBytes,signal)).buffer),rateDen=view.getUint16(12,false);
      if(!rateDen)throw containerRefusal('Invalid IFF MHDR rate denominator',invalidData);
      const channels=view.getUint16(16,false);
      if(!channels)throw containerRefusal('Invalid IFF MHDR channel count',invalidData);
      header={bits:view.getUint16(4,false),rateNum:view.getUint32(8,false),rateDen,channels,compression:view.getUint16(18,false)};
    }else if(id==='MDAT')body={start,end};
    else if(id==='CHAN'){
      if(size<4n||header===null)throw containerRefusal('Invalid IFF CHAN chunk',invalidData);
      const {bits,rateNum,rateDen,compression}:Mhdr=header,value=new DataView((await readAt(input,start,4,maxReadBytes,signal)).buffer).getUint32(0,false);
      header={bits,rateNum,rateDen,channels:value<6?1:2,compression};
    }else if(metadataChunks.has(id))metadata=true;
    else if(foreignChunks.has(id))throw new IffError('unsupported',`IFF ${JSON.stringify(id)} chunk in a MAUD form is not implemented`);
    position=end+(size&1n);
  }
  if(!header)throw containerRefusal('IFF MAUD without an MHDR chunk',invalidData);
  const codec=codecs.find(([bits,compression])=>bits===header.bits&&compression===header.compression)?.[2];
  if(!codec)throw containerRefusal(`IFF MAUD compression ${header.compression} and bit depth ${header.bits} are not supported`,patchWelcome);
  if(!body)throw new IffError('unsupported','IFF MAUD without an MDAT chunk is not implemented');
  const sampleRate=Math.floor(header.rateNum/header.rateDen),{channels}=header,width=codec==='pcm_s16be'?2:1;
  if(sampleRate<1||sampleRate>2147483647)throw new IffError('unsupported',`IFF MAUD sample rate ${sampleRate} is not implemented`);
  if(channels>saneChannels)throw new IffError('unsupported',`IFF MAUD channel count ${channels} exceeds ${saneChannels}`);
  const dataBytes=body.end-body.start;
  if(dataBytes%BigInt(channels*width))throw new IffError('unsupported','IFF MAUD trailing partial sample frame is not implemented');
  if(seek>0n)throw new IffError('unsupported','IFF input seek is not implemented');
  const offset=body.start,raw=await openRawPcm({size:dataBytes,readAt:(at,length,abort)=>input.readAt(offset+at,length,abort)},{codec:codec as PcmCodec,channels,sampleRate,channelMask:channels===1?monoMask:channels===2?stereoMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'iff' as const,bits:header.bits,compression:header.compression,rateNum:header.rateNum,rateDen:header.rateDen,metadata}),packets:raw.packets});
}
/** iff_read_packet reads min(body_end - pos, 1024 * block_align) with block_align = channels * bits (not bytes): 8192 samples. */
export function iffPacketSpan():bigint{return packetSamples;}
/** Registered by `export {iff} from './iff.js';` in registry.ts. Demux only: native has no iff muxer. */
export const iff=defineContainer({
  name:'iff',
  // The 'FORM' head overlaps aiff (30), so iff runs first at 26 (after nsp at 24) and confirms 'MAUD' at byte 8, which no AIFF/AIFC
  // file and no bare 4-byte FORM satisfies; a 'DS16' at byte 4 (nsp's check) is left to native's ambiguous-probe failure.
  demux:{probe:{precedence:26,head:bytes=>String.fromCharCode(...bytes)==='FORM',confirm:probeIff},headerBytes,
    open:(source,{maxReadBytes,signal,seek})=>openIff(source,{maxReadBytes,signal,seek}),packetSpan:iffPacketSpan}
});
