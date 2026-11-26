// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/cafenc.c, caf.c (ff_codec_caf_tags) and isom.c (mov_channel_layout, ff_mov_write_chan) (pinned FFmpeg 946fcce0). See NOTICE-CAF.
import type {WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import {muxRawPcm} from './raw-pcm.js';
import type {RawPcmMuxOptions} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
class CafError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type CafCodec='pcm_s8'|'pcm_s16le'|'pcm_s16be'|'pcm_s24le'|'pcm_s24be'|'pcm_s32le'|'pcm_s32be'|'pcm_f32le'|'pcm_f32be'|'pcm_f64le'|'pcm_f64be'|'pcm_alaw'|'pcm_mulaw';
export interface CafOutputFormat {readonly codec:CafCodec;readonly channels:number;readonly sampleRate:number;
  /** Native-order layout mask (stream.layoutMask); null writes no chan chunk (AV_CHANNEL_ORDER_UNSPEC). */
  readonly layoutMask:number|bigint|null;readonly bitexact:boolean}
/** ff_codec_caf_tags format id, cafenc.c codec_flags() and av_get_bits_per_sample() per codec. */
const codecs:Readonly<Record<CafCodec,readonly [id:string,flags:number,bits:number]>>={
  pcm_s8:['lpcm',0,8],pcm_s16le:['lpcm',2,16],pcm_s16be:['lpcm',0,16],pcm_s24le:['lpcm',2,24],pcm_s24be:['lpcm',0,24],pcm_s32le:['lpcm',2,32],pcm_s32be:['lpcm',0,32],
  pcm_f32le:['lpcm',3,32],pcm_f32be:['lpcm',1,32],pcm_f64le:['lpcm',3,64],pcm_f64be:['lpcm',1,64],pcm_alaw:['alaw',0,8],pcm_mulaw:['ulaw',0,8]
};
/** isom.c mov_channel_layout in table order: the first matching mask wins (stereo 101, quad 132, 5.0/5.1 back 117/121). */
const layouts:readonly (readonly [bigint,number])[]=[
  [0x4n,100<<16|1],[0x3n,101<<16|2],[0x3n,102<<16|2],[0x103n,131<<16|3],[0x33n,132<<16|4],[0x603n,132<<16|4],[0x33n,108<<16|4],[0x7n,113<<16|3],
  [0x107n,115<<16|4],[0x37n,117<<16|5],[0x607n,117<<16|5],[0x3fn,121<<16|6],[0x60fn,121<<16|6],[0x63fn,128<<16|8],[0x6cfn,126<<16|8],[0x6000003fn,130<<16|8],
  [0xbn,133<<16|3],[0x10bn,134<<16|4],[0x3bn,135<<16|4],[0x60bn,135<<16|4],[0xfn,136<<16|4],[0x10fn,137<<16|5]
];
const invalidData=183,encoder='Lavf63.1.102',maxHeaderBytes=8+44+24+(12+4+8+encoder.length+1)+16;
export function supportsCafCodec(codec:string):codec is CafCodec{return Object.hasOwn(codecs,codec);}
/** ff_mov_write_chan: [mChannelLayoutTag, mChannelBitmap] (the bitmap is the mask truncated by avio_wb32), no channel descriptions. */
export function cafChannelLayout(mask:number|bigint):readonly [number,number]{
  const value=BigInt(mask),tag=layouts.find(([layout])=>layout===value)?.[1];
  return tag?[tag>>>0,0]:[0x10000,Number(value&0xffffffffn)];
}
const popcount=(value:bigint)=>{let count=0;for(let rest=value;rest;rest&=rest-1n)count++;return count;};
function outputHeader(format:CafOutputFormat,samples:bigint):Uint8Array{
  const {codec,channels,sampleRate,layoutMask,bitexact}=format;
  if(!supportsCafCodec(codec))throw containerRefusal(`CAF muxer does not support ${codec}`,invalidData);
  if(!Number.isInteger(channels)||channels<1||channels>65535||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>2147483647||samples<0n)throw new CafError('invalid-data','Invalid CAF output parameters');
  if(layoutMask!==null&&(typeof layoutMask==='number'&&(!Number.isSafeInteger(layoutMask)||layoutMask<1)||BigInt(layoutMask)<1n||popcount(BigInt(layoutMask))!==channels))throw new CafError('unsupported','CAF output layout/count mismatch');
  const [id,flags,bits]=codecs[codec],blockAlign=channels*bits/8,dataBytes=samples*BigInt(blockAlign);
  if(dataBytes+4n>0x7fffffffffffffffn)throw new CafError('resource-limit','CAF data chunk exceeds the 64-bit size field');
  const info=bitexact?0:12+4+8+encoder.length+1,size=8+44+(layoutMask===null?0:24)+info+16,bytes=new Uint8Array(size),view=new DataView(bytes.buffer);
  let offset=0;const text=(value:string)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);offset+=value.length;},chunk=(tag:string,length:bigint)=>{text(tag);view.setBigUint64(offset,length,false);offset+=8;};
  text('caff');view.setUint16(offset,1,false);view.setUint16(offset+2,0,false);offset+=4;
  chunk('desc',32n);view.setFloat64(offset,sampleRate,false);offset+=8;text(id);
  view.setUint32(offset,flags,false);view.setUint32(offset+4,blockAlign,false);view.setUint32(offset+8,1,false);view.setUint32(offset+12,channels,false);view.setUint32(offset+16,bits,false);offset+=20;
  if(layoutMask!==null){const [tag,bitmap]=cafChannelLayout(layoutMask);chunk('chan',12n);view.setUint32(offset,tag,false);view.setUint32(offset+4,bitmap,false);view.setUint32(offset+8,0,false);offset+=12;}
  // av_dict_count(s->metadata): only the CLI's encoder tag reaches the muxer; tagged inputs are refused by the PCM path (dropsMetadata unset).
  if(info){chunk('info',BigInt(info-12));view.setUint32(offset,1,false);offset+=4;text('encoder');offset++;text(encoder);offset++;}
  // caf_write_trailer seeks back to write file_size - data - 8; PCM has frames_per_packet 1 and block_align set, so no pakt chunk follows.
  chunk('data',dataBytes+4n);view.setUint32(offset,0,false);offset+=4;
  return bytes;
}
/** Validation available before opening an output transaction. */
export function validateCafOutput(format:CafOutputFormat,samples:bigint):void{outputHeader(format,samples);}
/** Known-size sequential CAF output; the payload follows the header unchanged, and raw packet validation owns the transaction. */
export async function muxCaf(output:WriteHandle,format:CafOutputFormat,packets:AsyncIterable<MediaPacket>,options:RawPcmMuxOptions):Promise<void>{
  let abortAttempted=false;
  try{
    const stable={...format},header=outputHeader(stable,options.sampleCount),{maxWriteBytes,signal}=options;
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new CafError('resource-limit','Invalid CAF write budget');
    for(let offset=0;offset<header.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(header.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}
    await muxRawPcm({write:chunk=>output.write(chunk),commit:()=>output.commit(),async abort(reason){abortAttempted=true;await output.abort(reason);}},{codec:stable.codec,channels:stable.channels,sampleRate:stable.sampleRate},packets,options);
  }catch(error){if(!abortAttempted)try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'CAF output and abort failed');}throw error;}
}
const format=({codec,channels,sampleRate,layoutMask,bitexact}:{readonly codec:PcmCodec;readonly channels:number;readonly sampleRate:number;readonly layoutMask:number|bigint|null;readonly bitexact:boolean}):CafOutputFormat=>({codec:codec as CafCodec,channels,sampleRate,layoutMask,bitexact});
/** Registered by `export {caf} from './caf.js';` in registry.ts. Mux only; demuxer.caf is a follow-up on this module. */
export const caf=defineContainer({
  name:'caf',
  // caf_write_init: a codec without a ff_codec_caf_tags entry (pcm_u8, pcm_u16le, ...) fails with AVERROR_INVALIDDATA before any byte.
  mux:{label:'CAF',extensions:['.caf'],defaultCodec:'pcm_s16be',supports:supportsCafCodec,refuse:codec=>containerRefusal(`CAF muxer does not support ${codec}`,invalidData),scratchBytes:maxHeaderBytes,
    validate:stream=>validateCafOutput(format(stream),stream.samples),
    write:(output,stream,packets,{maxWriteBytes,signal})=>muxCaf(output,format(stream),packets,{sampleCount:stream.samples,maxWriteBytes,signal})}
});
