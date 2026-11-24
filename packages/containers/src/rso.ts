// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/rsodec.c, rsoenc.c, rso.c and pcm.c (pinned FFmpeg 946fcce0). See NOTICE-RSO.
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import {openRawPcm,muxRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput,RawPcmMuxOptions} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class RsoError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type RsoCodec='pcm_u8';
export interface RsoInfo extends RawPcmInfo {readonly container:'rso';readonly declaredDataBytes:number}
export interface RsoInput extends Omit<RawPcmInput,'info'> {readonly info:RsoInfo}
export interface RsoOutputFormat {readonly codec:PcmCodec;readonly channels:number;readonly sampleRate:number}
/** ff_codec_rso_tags; 0x0101 (adpcm_ima_wav) is native's PATCHWELCOME, as is any unknown tag (no bits per sample). */
const headerBytes=8,pcmU8Tag=0x0100,adpcmTag=0x0101,maxCodedSize=0xffff,invalidData=183,patchWelcome=176;
export function supportsRsoCodec(codec:string):codec is RsoCodec{return codec==='pcm_u8';}
/** Finite range-backed RSO: an 8-byte big-endian header, then pcm_u8 mono to EOF. The header size is informational, as in native ff_pcm_read_packet. */
export async function openRso(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<RsoInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new RsoError('resource-limit','Invalid RSO read budget');
  if(input.size<BigInt(headerBytes))throw new RsoError('invalid-data','Truncated RSO header');
  const header=new Uint8Array(headerBytes);let filled=0;
  while(filled<headerBytes){signal?.throwIfAborted();const requested=Math.min(headerBytes-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new RsoError('invalid-data','Unexpected RSO header read length');header.set(chunk,filled);filled+=chunk.length;}
  const view=new DataView(header.buffer),tag=view.getUint16(0,false),declaredDataBytes=view.getUint16(2,false),sampleRate=view.getUint16(4,false);
  if(tag===adpcmTag)throw containerRefusal('ADPCM in RSO is not implemented',patchWelcome);
  if(tag!==pcmU8Tag)throw containerRefusal(`Unsupported RSO codec tag: ${tag}`,patchWelcome);
  if(sampleRate<1)throw new RsoError('unsupported','RSO sample rate 0 is not implemented');
  const offset=BigInt(headerBytes),raw=await openRawPcm({size:input.size-offset,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec:'pcm_u8',channels:1,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'rso' as const,declaredDataBytes}),packets:raw.packets});
}
/** rso_write_header refusals in native order (codec tag, mono, rate), then the header rso_write_trailer leaves on a seekable output. */
function outputHeader(format:RsoOutputFormat,samples:bigint):Uint8Array{
  const {codec,channels,sampleRate}=format;
  if(!supportsRsoCodec(codec))throw containerRefusal(`RSO muxer does not support ${codec}`,invalidData);
  if(channels!==1)throw containerRefusal('RSO only supports mono',invalidData);
  if(!Number.isInteger(sampleRate)||sampleRate<1)throw new RsoError('invalid-data','Invalid RSO output sample rate');
  if(sampleRate>maxCodedSize)throw containerRefusal('Sample rate must be < 65536',invalidData);
  if(samples<0n)throw new RsoError('invalid-data','Invalid RSO output sample count');
  const bytes=new Uint8Array(headerBytes),view=new DataView(bytes.buffer);
  view.setUint16(0,pcmU8Tag,false);view.setUint16(2,samples>BigInt(maxCodedSize)?maxCodedSize:Number(samples),false);view.setUint16(4,sampleRate,false);
  return bytes;
}
/** Validation available before opening an output transaction. */
export function validateRsoOutput(format:RsoOutputFormat,samples:bigint):void{outputHeader(format,samples);}
/** Known-size sequential RSO output; raw packet validation owns the transaction. */
export async function muxRso(output:WriteHandle,format:RsoOutputFormat,packets:AsyncIterable<MediaPacket>,options:RawPcmMuxOptions):Promise<void>{
  let abortAttempted=false;
  try{
    const stable={...format},header=outputHeader(stable,options.sampleCount),{maxWriteBytes,signal}=options;
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new RsoError('resource-limit','Invalid RSO write budget');
    for(let offset=0;offset<header.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(header.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}
    await muxRawPcm({write:chunk=>output.write(chunk),commit:()=>output.commit(),async abort(reason){abortAttempted=true;await output.abort(reason);}},stable,packets,options);
  }catch(error){if(!abortAttempted)try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'RSO output and abort failed');}throw error;}
}
/** Native has no rso read_probe: undeclared inputs are detected only by the .rso extension. rso_write_header writes no tags. */
export const rso=defineContainer({
  name:'rso',
  demux:{extensions:['.rso'],headerBytes,open:(source,{maxReadBytes,signal})=>openRso(source,{maxReadBytes,signal})},
  mux:{label:'RSO',extensions:['.rso'],defaultCodec:'pcm_u8',supports:supportsRsoCodec,refuse:codec=>containerRefusal(`RSO muxer does not support ${codec}`,invalidData),scratchBytes:headerBytes,dropsMetadata:true,
    validate:({codec,channels,sampleRate,samples})=>validateRsoOutput({codec,channels,sampleRate},samples),
    write:(output,{codec,channels,sampleRate,samples},packets,{maxWriteBytes,signal})=>muxRso(output,{codec,channels,sampleRate},packets,{sampleCount:samples,maxWriteBytes,signal})}
});
