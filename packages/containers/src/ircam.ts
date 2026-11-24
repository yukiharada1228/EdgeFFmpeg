// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/ircam.c, ircamdec.c, ircamenc.c, pcm.c and libavutil/rational.c av_q2intfloat (pinned FFmpeg 946fcce0). See NOTICE-IRCAM.
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import {openRawPcm,muxRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput,RawPcmMuxOptions} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
class IrcamError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type IrcamCodec='pcm_alaw'|'pcm_mulaw'|'pcm_s8'|'pcm_s16le'|'pcm_s24le'|'pcm_s32le'|'pcm_f32le'|'pcm_f64le';
export interface IrcamInfo extends RawPcmInfo {readonly container:'ircam';readonly littleEndian:boolean;readonly magic:number}
export interface IrcamInput extends Omit<RawPcmInput,'info'> {readonly info:IrcamInfo}
export interface IrcamOutputFormat {readonly codec:IrcamCodec;readonly channels:number;readonly sampleRate:number}
/** ff_codec_ircam_le_tags/ff_codec_ircam_be_tags in table order; ff_toupper4's second pass cannot match tags whose bytes are all 0..4. */
const leTags:readonly (readonly [PcmCodec,number])[]=[['pcm_alaw',0x10001],['pcm_f32le',4],['pcm_f64le',8],['pcm_mulaw',0x20001],['pcm_s16le',2],['pcm_s24le',3],['pcm_s32le',0x40004],['pcm_s8',1]];
const beTags:readonly (readonly [PcmCodec,number])[]=[['pcm_alaw',0x10001],['pcm_f32be',4],['pcm_f64be',8],['pcm_mulaw',0x20001],['pcm_s16be',2],['pcm_s24be',3],['pcm_s32be',0x40004],['pcm_s8',1]];
/** ircamdec.c table[]: magic read little-endian, then the endianness of the fields that follow. */
const magics:readonly (readonly [number,boolean])[]=[[0x64a30100,false],[0x64a30200,true],[0x64a30300,false],[0x64a30400,true],[0x0001a364,true],[0x0002a364,false],[0x0003a364,true]];
const headerBytes=16,dataOffset=1024,saneChannels=512,invalidData=183,enosys=218,einval=234;
export function supportsIrcamCodec(codec:string):codec is IrcamCodec{return leTags.some(([name])=>name===codec);}
async function readHead(input:ReadHandle,length:number,maxReadBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=new Uint8Array(length),available=input.size<BigInt(length)?Number(input.size):length;let filled=0;
  while(filled<available){signal?.throwIfAborted();const requested=Math.min(available-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new IrcamError('invalid-data','Unexpected IRCAM header read length');bytes.set(chunk,filled);filled+=chunk.length;}
  return bytes;
}
/** ircam_probe's first four bytes; the big-endian-looking form also needs nonzero words at 4 and 8 (confirm). */
function probeHead(b:Uint8Array):0|1|2{return b[0]===0x64&&b[1]===0xa3&&b[3]===0&&b[2]!>=1&&b[2]!<=4?1:b[3]===0x64&&b[2]===0xa3&&b[0]===0&&b[1]!>=1&&b[1]!<=3?2:0;}
/** lrintf in the default rounding mode, for finite floats whose result fits a 32-bit int; other values are platform dependent. */
export function ircamRate(value:number):number|null{
  if(!Number.isFinite(value))return null;
  const floor=Math.floor(value),fraction=value-floor,rounded=fraction>0.5||fraction===0.5&&floor%2!==0?floor+1:floor;
  return rounded>=-2147483648&&rounded<2147483648?rounded+0:null;
}
/** av_q2intfloat((AVRational){rate,1}) for a positive int rate: av_rescale rounds half away from zero. */
export function ircamRateBits(rate:number):number{
  if(!Number.isSafeInteger(rate)||rate<1||rate>2147483647)throw new IrcamError('invalid-data','Invalid IRCAM output sample rate');
  const num=BigInt(rate),log2=(value:bigint)=>value.toString(2).length-1,rescale=(shift:number)=>shift>=0?num<<BigInt(shift):(num+(1n<<BigInt(-shift-1)))>>BigInt(-shift);
  let shift=23-log2(num),n=rescale(shift);
  shift-=n>=1n<<24n?1:0;shift+=n<1n<<23n?1:0;n=rescale(shift);
  return ((150-shift)<<23|Number(n-(1n<<23n)))>>>0;
}
/** Finite range-backed IRCAM: a 16-byte header (zero-filled past EOF, as avio_rl32 reads), PCM from byte 1024 to EOF. */
export async function openIrcam(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<IrcamInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new IrcamError('resource-limit','Invalid IRCAM read budget');
  const header=await readHead(input,headerBytes,maxReadBytes,signal),view=new DataView(header.buffer),magic=view.getUint32(0,true),entry=magics.find(([value])=>value===magic);
  if(!entry)throw containerRefusal('Invalid IRCAM magic',invalidData);
  const le=entry[1],rateValue=view.getFloat32(4,le),channels=view.getUint32(8,le),tag=view.getUint32(12,le),sampleRate=ircamRate(rateValue);
  if(sampleRate===null)throw new IrcamError('unsupported','IRCAM sample rate outside the 32-bit lrintf range is platform dependent and not implemented');
  if(!channels||!sampleRate)throw containerRefusal('Invalid IRCAM channels or sample rate',invalidData);
  if(channels>=2147483648)throw new IrcamError('unsupported','IRCAM channel counts of 2^31 or more are not implemented');
  if(channels>saneChannels)throw containerRefusal(`IRCAM channel count ${channels} exceeds ${saneChannels}`,enosys);
  const codec=(le?leTags:beTags).find(([,value])=>value===tag)?.[0];
  if(!codec)throw containerRefusal(`unknown tag ${tag.toString(16)}`,invalidData);
  if(sampleRate<0)throw new IrcamError('unsupported','Negative IRCAM sample rates are not implemented');
  const offset=BigInt(dataOffset),size=input.size>offset?input.size-offset:0n;
  const raw=await openRawPcm({size,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'ircam' as const,littleEndian:le,magic}),packets:raw.packets});
}
/** ff_pcm_default_packet_size in samples: bitrate/8/10/block_align, clipped to [1, INT_MAX/block_align], floored to a power of two. */
export function ircamPacketSpan(info:{readonly sampleRate:number;readonly blockAlign:number}):bigint{
  const max=BigInt(Math.floor(2147483647/info.blockAlign));let samples=BigInt(Math.floor(info.sampleRate/10));
  if(samples<1n)samples=1n;if(samples>max)samples=max;
  return 1n<<BigInt(samples.toString(2).length-1);
}
function outputHeader(format:IrcamOutputFormat,samples:bigint):Uint8Array{
  const {codec,channels,sampleRate}=format,tag=leTags.find(([name])=>name===codec)?.[1];
  if(tag===undefined)throw containerRefusal(`IRCAM muxer does not support ${codec}`,einval);
  if(!Number.isInteger(channels)||channels<1||channels>65535||samples<0n)throw new IrcamError('invalid-data','Invalid IRCAM output parameters');
  const bytes=new Uint8Array(dataOffset),view=new DataView(bytes.buffer);
  view.setUint32(0,0x0001a364,true);view.setUint32(4,ircamRateBits(sampleRate),true);view.setUint32(8,channels,true);view.setUint32(12,tag,true);
  return bytes;
}
/** Validation available before opening an output transaction. */
export function validateIrcamOutput(format:IrcamOutputFormat,samples:bigint):void{outputHeader(format,samples);}
/** Known-size sequential IRCAM output; raw packet validation owns the transaction. */
export async function muxIrcam(output:WriteHandle,format:IrcamOutputFormat,packets:AsyncIterable<MediaPacket>,options:RawPcmMuxOptions):Promise<void>{
  let abortAttempted=false;
  try{
    const stable={...format},header=outputHeader(stable,options.sampleCount),{maxWriteBytes,signal}=options;
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new IrcamError('resource-limit','Invalid IRCAM write budget');
    for(let offset=0;offset<header.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(header.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}
    await muxRawPcm({write:chunk=>output.write(chunk),commit:()=>output.commit(),async abort(reason){abortAttempted=true;await output.abort(reason);}},stable,packets,options);
  }catch(error){if(!abortAttempted)try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'IRCAM output and abort failed');}throw error;}
}
/** Registered by `export {ircam} from './ircam.js';` in registry.ts. */
export const ircam=defineContainer({
  name:'ircam',
  // Exact native probe heads: no pre-registry head starts 64 A3 or 00 0x A3 64. Native's .sf/.ircam extension score (1) loses to any
  // other positive probe score, so it is payload dependent and not mirrored: unprobed heads (0x64A30400) need -f ircam.
  demux:{probe:{precedence:100,head:bytes=>probeHead(bytes)!==0,
    async confirm(input,maxReadBytes,signal){const b=await readHead(input,12,maxReadBytes,signal),view=new DataView(b.buffer);return probeHead(b)===1||view.getUint32(4,true)!==0&&view.getUint32(8,true)!==0;}},
    headerBytes,open:(source,{maxReadBytes,signal})=>openIrcam(source,{maxReadBytes,signal}),packetSpan:ircamPacketSpan},
  mux:{label:'IRCAM',extensions:['.sf','.ircam'],defaultCodec:'pcm_s16le',supports:supportsIrcamCodec,refuse:codec=>containerRefusal(`IRCAM muxer does not support ${codec}`,einval),scratchBytes:dataOffset,dropsMetadata:true,
    validate:({codec,channels,sampleRate,samples})=>validateIrcamOutput({codec:codec as IrcamCodec,channels,sampleRate},samples),
    write:(output,{codec,channels,sampleRate,samples},packets,{maxWriteBytes,signal})=>muxIrcam(output,{codec:codec as IrcamCodec,channels,sampleRate},packets,{sampleCount:samples,maxWriteBytes,signal})}
});
