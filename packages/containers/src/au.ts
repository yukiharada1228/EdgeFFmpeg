import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import {openRawPcm,muxRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput,RawPcmMuxOptions} from './raw-pcm.js';
const encodings={pcm_mulaw:[1,1],pcm_s8:[2,1],pcm_s16be:[3,2],pcm_s24be:[4,3],pcm_s32be:[5,4],pcm_f32be:[6,4],pcm_f64be:[7,8],pcm_alaw:[27,1]} as const;
export type AuCodec=Extract<PcmCodec,keyof typeof encodings>;
export class AuError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface AuOptions {readonly maxReadBytes:number;readonly signal?:AbortSignal}
export interface AuInfo extends RawPcmInfo {readonly container:'au';readonly declaredDataBytes:bigint|null}
export interface AuInput extends Omit<RawPcmInput,'info'> {readonly info:AuInfo}
export interface AuOutputFormat {readonly codec:AuCodec;readonly channels:number;readonly sampleRate:number;readonly channelMask?:number|null}
export type AuMuxOptions=RawPcmMuxOptions;
export function supportsAuCodec(codec:string):codec is AuCodec{return Object.hasOwn(encodings,codec);}
/** Finite range-backed AU. Annotation bytes are skipped without allocating them. */
export async function openAu(input:ReadHandle,options:AuOptions):Promise<AuInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new AuError('resource-limit','Invalid AU read budget');
  if(input.size<24n)throw new AuError('invalid-data','Truncated AU header');
  const header=new Uint8Array(24);let filled=0;
  while(filled<24){signal?.throwIfAborted();const requested=Math.min(24-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new AuError('invalid-data','Unexpected AU header read length');header.set(chunk,filled);filled+=chunk.length;}
  const view=new DataView(header.buffer),offset=BigInt(view.getUint32(4,false)),size=view.getUint32(8,false),encoding=view.getUint32(12,false),sampleRate=view.getUint32(16,false),channels=view.getUint32(20,false);
  if(view.getUint32(0,false)!==0x2e736e64)throw new AuError('invalid-data','Expected AU signature');
  if(offset<24n||offset>input.size)throw new AuError('invalid-data','Invalid AU data offset');
  const codec=Object.keys(encodings).find(codec=>encodings[codec as AuCodec][0]===encoding) as AuCodec|undefined;
  if(!codec)throw new AuError('unsupported',`Unsupported AU encoding: ${encoding}`);
  if(channels<1||channels>65535||sampleRate<1||sampleRate>2147483647)throw new AuError('unsupported','Unsupported AU rate or channel count');
  const declaredDataBytes=size===0xffffffff?null:BigInt(size),dataBytes=declaredDataBytes??input.size-offset;
  if(offset+dataBytes>input.size)throw new AuError('invalid-data','AU sound data exceeds input');
  if(declaredDataBytes!==null&&offset+dataBytes!==input.size)throw new AuError('unsupported','AU declared/physical data length mismatch is not implemented');
  const raw=await openRawPcm({size:dataBytes,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'au' as const,declaredDataBytes}),packets:raw.packets});
}
function outputHeader(format:AuOutputFormat,sampleCount:bigint):Uint8Array{
  if(!supportsAuCodec(format.codec))throw new AuError('unsupported','Unsupported AU output codec');
  const {sampleRate,channels}=format;
  if(!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>2147483647||!Number.isInteger(channels)||channels<1||channels>65535||sampleCount<0n)throw new AuError('invalid-data','Invalid AU output parameters');
  const size=sampleCount*BigInt(channels*encodings[format.codec][1]);
  if(size>=0xffffffffn)throw new AuError('unsupported','AU known-size output exceeds 32-bit data length');
  const header=new Uint8Array(32),view=new DataView(header.buffer);
  [0x2e736e64,32,Number(size),encodings[format.codec][0],sampleRate,channels].forEach((value,index)=>view.setUint32(index*4,value,false));
  return header;
}
export function validateAuOutput(format:AuOutputFormat,sampleCount:bigint):void{outputHeader(format,sampleCount);}
/** Known length permits sequential header output without a final seek or rewrite. */
export async function muxAu(output:WriteHandle,format:AuOutputFormat,packets:AsyncIterable<MediaPacket>,options:AuMuxOptions):Promise<void>{
  let abortAttempted=false;
  try{
    const stable={...format},header=outputHeader(stable,options.sampleCount),{maxWriteBytes,signal}=options;
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new AuError('resource-limit','Invalid AU write budget');
    for(let offset=0;offset<header.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(header.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}
    await muxRawPcm({write:chunk=>output.write(chunk),commit:()=>output.commit(),async abort(reason){abortAttempted=true;await output.abort(reason);}},stable,packets,options);
  }catch(error){if(!abortAttempted)try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'AU output and abort failed');}throw error;}
}
