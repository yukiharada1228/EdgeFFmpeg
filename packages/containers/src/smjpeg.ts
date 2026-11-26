// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/smjpegenc.c, smjpeg.c and smjpeg.h, audio-only pcm_s16le (pinned FFmpeg 946fcce0). See NOTICE-SMJPEG.
import type {WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {framePcmPackets,planPcmFraming} from './pcm-framing.js';
import type {PcmFraming,PcmFramingPlan} from './pcm-framing.js';
import {ffmpegReferenceMuxerSoftware} from './reference-metadata.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
class SmjpegError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export interface SmjpegOutputFormat {readonly codec:string;readonly channels:number;readonly sampleRate:number;readonly samples:bigint;readonly bitexact:boolean}
export interface SmjpegMuxOptions {readonly maxWriteBytes:number;readonly signal?:AbortSignal;readonly framing:PcmFraming}
/** smjpeg.h chunk tags (MKTAG, written little-endian, so in reading order) and SMJPEG_MAGIC; ff_codec_smjpeg_audio_tags maps pcm_s16le to NONE. */
const ascii=(text:string)=>Uint8Array.from(text,char=>char.charCodeAt(0));
const magic=ascii('\0\nSMJPEG'),txt=ascii('_TXT'),snd=ascii('_SND'),sndd=ascii('sndD'),hend=ascii('HEND'),done=ascii('DONE'),none=ascii('NONE');
const encoderTag=ascii(`encoder = ${ffmpegReferenceMuxerSoftware}`),einval=234,maxChannels=255,packetHeaderBytes=12,syntheticBytes=4096;
export const smjpegScratchBytes=128;
export function supportsSmjpegCodec(codec:string):codec is 'pcm_s16le'{return codec==='pcm_s16le';}
/** av_rescale_rnd(a, b, c, AV_ROUND_NEAR_INF): half away from zero, negative inputs mirrored. */
export function smjpegRescale(value:bigint,num:bigint,den:bigint):bigint{return value<0n?-smjpegRescale(-value,num,den):(value*num+den/2n)/den;}
/** pts (1/sampleRate) to the muxer's 1/1000 time base, as av_packet_rescale_ts does (NEAR_INF|PASS_MINMAX for pts, NEAR_INF for duration). */
export function smjpegMilliseconds(samples:bigint,sampleRate:number):bigint{return smjpegRescale(samples,1000n,BigInt(sampleRate));}
function check(format:SmjpegOutputFormat):void{
  const {codec,channels,sampleRate,samples}=format;
  if(!supportsSmjpegCodec(codec))throw containerRefusal(`SMJPEG muxer does not support ${codec}`,einval);
  if(!Number.isInteger(channels)||channels<1||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>2147483647||typeof samples!=='bigint'||samples<0n)throw new SmjpegError('invalid-data','Invalid SMJPEG output parameters');
  // avio_w8 truncates the channel count; native output above 255 channels is unprobed.
  if(channels>maxChannels)throw new SmjpegError('unsupported',`SMJPEG output with more than ${maxChannels} channels is not implemented`);
}
/** smjpeg_write_header for one pcm_s16le stream; duration is the trailer's value, written up front because the output never seeks. */
export function smjpegHeader(format:SmjpegOutputFormat,duration:bigint):Uint8Array{
  check(format);
  const text=format.bitexact?0:8+encoderTag.length,bytes=new Uint8Array(16+text+16+4),view=new DataView(bytes.buffer);
  bytes.set(magic);view.setUint32(8,0);view.setUint32(12,Number(BigInt.asUintN(32,duration)));let at=16;
  if(text){bytes.set(txt,at);view.setUint32(at+4,encoderTag.length);bytes.set(encoderTag,at+8);at+=text;}
  bytes.set(snd,at);view.setUint32(at+4,8);view.setUint16(at+8,format.sampleRate&0xffff);bytes[at+10]=16;bytes[at+11]=format.channels;bytes.set(none,at+12);at+=16;
  bytes.set(hend,at);return bytes;
}
/** Validation available before opening an output transaction. */
export function validateSmjpegOutput(format:SmjpegOutputFormat):void{check(format);}
function plan(format:SmjpegOutputFormat,framing:PcmFraming):PcmFramingPlan{
  const result=planPcmFraming(framing,'smjpeg',message=>new SmjpegError('invalid-data',message));
  if(result.blockAlign!==format.channels*2||result.sampleCount!==format.samples||result.startPts<0n)throw new SmjpegError('invalid-data','Invalid smjpeg framing');
  return result;
}
/** The trailer duration: max(pts + duration) in ms over the native packets, kept in a uint32_t as smjpeg_write_packet does. */
export async function smjpegDuration(format:SmjpegOutputFormat,framing:PcmFraming,signal?:AbortSignal):Promise<bigint>{
  check(format);
  const framed=plan(format,framing),align=framed.blockAlign,zero=new Uint8Array(Math.max(1,Math.floor(syntheticBytes/align))*align),step=BigInt(zero.length/align),timeBase={num:1n,den:BigInt(format.sampleRate)};
  async function* synthetic(){for(let at=0n;at<framed.sampleCount;){const count=framed.sampleCount-at<step?framed.sampleCount-at:step;yield {streamIndex:0,data:zero.subarray(0,Number(count)*align),pts:at,dts:at,duration:count,timeBase,flags:1};at+=count;}}
  let duration=0n;
  for await(const chunk of framePcmPackets(framed,synthetic(),signal))if(chunk.end){const end=smjpegMilliseconds(chunk.pts,format.sampleRate)+smjpegMilliseconds(chunk.duration,format.sampleRate);if(end>duration)duration=BigInt.asUintN(32,end);}
  return duration;
}
/** Known-size sequential SMJPEG output: header, one sndD chunk per native packet (framing), DONE. */
export async function muxSmjpeg(output:WriteHandle,format:SmjpegOutputFormat,packets:AsyncIterable<MediaPacket>,options:SmjpegMuxOptions):Promise<void>{
  try{
    const stable={...format},{maxWriteBytes,signal}=options;signal?.throwIfAborted();
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new SmjpegError('resource-limit','Invalid SMJPEG write budget');
    check(stable);const framed=plan(stable,options.framing),rate=BigInt(stable.sampleRate);
    const header=smjpegHeader(stable,await smjpegDuration(stable,options.framing,signal));
    const write=async(bytes:Uint8Array)=>{for(let offset=0;offset<bytes.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(bytes.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}};
    async function* checked(){for await(const packet of packets){signal?.throwIfAborted();if(packet.streamIndex!==0||packet.timeBase.num<=0n||packet.timeBase.den!==packet.timeBase.num*rate)throw new SmjpegError('invalid-data','Invalid SMJPEG packet');yield packet;}}
    await write(header);let start=true;
    for await(const chunk of framePcmPackets(framed,checked(),signal)){
      if(start){const head=new Uint8Array(packetHeaderBytes),view=new DataView(head.buffer);head.set(sndd);view.setUint32(4,Number(BigInt.asUintN(32,smjpegMilliseconds(chunk.pts,stable.sampleRate))));view.setUint32(8,Number(chunk.duration)*framed.blockAlign);await write(head);}
      await write(chunk.bytes);start=chunk.end;
    }
    await write(done);signal?.throwIfAborted();await output.commit();
  }catch(error){try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'SMJPEG output and abort failed');}throw error;}
}
/** Registered by `export {smjpeg} from './smjpeg.js';` in registry.ts. Mux-only: native smjpeg has no output extension, so -f smjpeg is required. */
export const smjpeg=defineContainer({
  name:'smjpeg',
  mux:{label:'SMJPEG',defaultCodec:'pcm_s16le',supports:supportsSmjpegCodec,refuse:codec=>containerRefusal(`SMJPEG muxer does not support ${codec}`,einval),scratchBytes:smjpegScratchBytes,
    validate:({codec,channels,sampleRate,samples,bitexact})=>validateSmjpegOutput({codec,channels,sampleRate,samples,bitexact}),
    write:(output,{codec,channels,sampleRate,samples,bitexact},packets,{maxWriteBytes,signal,framing})=>muxSmjpeg(output,{codec,channels,sampleRate,samples,bitexact},packets,{maxWriteBytes,signal,framing})}
});
