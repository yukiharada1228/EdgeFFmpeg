// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/hashenc.c (framehash_init, framehash_write_header, framehash_write_packet) and framehash.c (ff_framehash_write_header) (pinned FFmpeg 946fcce0). See ../../NOTICE-FRAMEHASH.
import type {WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import {containerRefusal,defineContainer} from '../registry-descriptor.js';
import type {ContainerFraming,ContainerMuxer,ContainerOption} from '../registry-descriptor.js';
import {framePcmPackets,planPcmFraming} from '../pcm-framing.js';
import {muxerSoftware} from '../reference-metadata.js';
import type {ReferenceMetadataProfile} from '../reference-metadata.js';
import {rawPcmCodec} from '../raw-pcm.js';
import {createDigest,digestHex} from './digests.js';
export class FrameHashMuxError extends Error {}
export type FrameHashMuxerName='framemd5'|'framehash';
/** HASH_OPT defaults (framemd5 md5, framehash sha256); FORMAT_VERSION_OPT defaults to 2. */
const algorithms:Readonly<Record<FrameHashMuxerName,string>>={framemd5:'md5',framehash:'sha256'};
const formatVersion=2;
export interface FrameHashAudioFormat {readonly codec:PcmCodec;readonly sampleRate:number;
  /** av_channel_layout_describe of the output layout; '' is refused (as framecrc). */
  readonly channelLayout:string}
export interface FrameHashMuxOptions {readonly maxWriteBytes:number;readonly framing:ContainerFraming;readonly bitexact?:boolean;readonly metadataProfile?:ReferenceMetadataProfile;readonly signal?:AbortSignal}
/** -hash and -format_version are AVOptions natively, but only their defaults are implemented; the CLI parser refuses both first today. */
export function validateFrameHashOutput(muxer:FrameHashMuxerName,channelLayout:string,options:readonly ContainerOption[]):void{
  if(options.length)throw containerRefusal(`The ${muxer} muxer ${options[0]!.name} option is not implemented`);
  if(!channelLayout)throw containerRefusal(`Unknown channel mask for ${muxer} output`);
}
const minInt64=-(1n<<63n),maxInt64=(1n<<63n)-1n;
function integer(value:bigint):string{if(value<minInt64||value>maxInt64)throw new FrameHashMuxError('Timestamp exceeds signed 64-bit range');return String(value);}
/**
 * One PCM audio stream as per-packet digests. Packets are regrouped to the native packet boundaries of framing
 * (framePcmPackets) and hashed incrementally, so no whole packet is buffered. PCM has no extradata or side data:
 * no #extradata line and no S= suffix.
 */
export async function muxFrameHash(output:WriteHandle,muxer:FrameHashMuxerName,format:FrameHashAudioFormat,packets:AsyncIterable<MediaPacket>,options:FrameHashMuxOptions):Promise<void>{
  try{
    const {maxWriteBytes,signal}=options;signal?.throwIfAborted();
    const software=muxerSoftware(options.metadataProfile);
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1||!Number.isInteger(format.sampleRate)||format.sampleRate<1||format.sampleRate>2147483647||rawPcmCodec(format.codec.slice(4))!==format.codec||!/^[a-zA-Z0-9 .()+_-]{1,128}$/.test(format.channelLayout))throw new FrameHashMuxError(`Invalid ${muxer} audio parameters`);
    const framing=planPcmFraming(options.framing,muxer,message=>new FrameHashMuxError(message));
    const name=algorithms[muxer],encoder=new TextEncoder();
    let digest=createDigest(name)!;
    const write=async(text:string)=>{
      const bytes=encoder.encode(text);
      for(let offset=0;offset<bytes.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(bytes.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}
    };
    await write(`#format: frame checksums\n#version: ${formatVersion}\n#hash: ${digest.name}\n${options.bitexact?'':`#software: ${software}\n`}#tb 0: 1/${format.sampleRate}\n#media_type 0: audio\n#codec_id 0: ${format.codec}\n#sample_rate 0: ${format.sampleRate}\n#channel_layout_name 0: ${format.channelLayout}\n#stream#, dts,        pts, duration,     size, hash\n`);
    async function* checked(){
      for await(const packet of packets){
        signal?.throwIfAborted();
        if(packet.streamIndex!==0||packet.timeBase.num<=0n||packet.timeBase.den!==packet.timeBase.num*BigInt(format.sampleRate))throw new FrameHashMuxError(`Invalid ${muxer} packet`);
        yield packet;
      }
    }
    for await(const chunk of framePcmPackets(framing,checked(),signal)){
      digest.update(chunk.bytes,signal);
      if(chunk.end){
        const pts=integer(chunk.pts).padStart(10);
        await write(`0, ${pts}, ${pts}, ${integer(chunk.duration).padStart(8)}, ${String(Number(chunk.duration)*framing.blockAlign).padStart(8)}, ${digestHex(digest)}\n`);
        digest=createDigest(name)!;
      }
    }
    signal?.throwIfAborted();
    await output.commit();
  }catch(error){
    try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'Frame hash muxer output and abort failed');}
    throw error;
  }
}
/** Digest state (64-byte block, 32-byte state) plus the header and the longest row. */
const scratchBytes=640;
function frameHashMuxer(name:FrameHashMuxerName):ContainerMuxer{
  return {label:name,defaultCodec:'pcm_s16le',supports:()=>true,scratchBytes,dropsMetadata:true,
    validate:({channelLayout,options})=>validateFrameHashOutput(name,channelLayout,options),
    write:(output,{codec,sampleRate,channelLayout,bitexact},packets,{maxWriteBytes,signal,framing})=>muxFrameHash(output,name,{codec,sampleRate,channelLayout},packets,{...(bitexact?{}:{metadataProfile:'ffmpeg-9.0.2' as const}),maxWriteBytes,signal,bitexact,framing})};
}
/** Registered by `export {framemd5} from './hash/frame-hash-mux.js';` (and framehash) in registry.ts. */
export const framemd5=defineContainer({name:'framemd5',mux:frameHashMuxer('framemd5')});
export const framehash=defineContainer({name:'framehash',mux:frameHashMuxer('framehash')});
