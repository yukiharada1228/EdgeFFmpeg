import type {PackedSampleFormat} from '@edge-ffmpeg/swresample';
import {decodeG711,encodeG711,isG711Codec} from './g711.js';
import { convertAudioFrame } from '@edge-ffmpeg/swresample';
import { rescale } from '@edge-ffmpeg/avutil';
import type { AudioFrameData, MediaPacket, PcmCodec } from '@edge-ffmpeg/avutil';
export type { PcmCodec } from '@edge-ffmpeg/avutil';
export interface PcmFormat { readonly codec: PcmCodec; readonly channels: number; readonly sampleRate: number; readonly channelLayout?: string }
export interface PcmOptions { readonly maxFrameBytes: number; readonly signal?: AbortSignal }
export class PcmError extends Error {}
interface PcmEncoding {bytes:1|2|3|4|8;sampleFormat:PackedSampleFormat;frameBytes:1|2|4|8;bigEndian?:boolean;flipSign?:boolean}
const formats:Record<PcmCodec,PcmEncoding> = {
  pcm_s8:{bytes:1,sampleFormat:'u8',frameBytes:1,flipSign:true},
  pcm_s16be:{bytes:2,sampleFormat:'s16',frameBytes:2,bigEndian:true},
  pcm_s24be:{bytes:3,sampleFormat:'s32',frameBytes:4,bigEndian:true},
  pcm_s32be:{bytes:4,sampleFormat:'s32',frameBytes:4,bigEndian:true},
  pcm_u16le:{bytes:2,sampleFormat:'s16',frameBytes:2,flipSign:true},
  pcm_u16be:{bytes:2,sampleFormat:'s16',frameBytes:2,bigEndian:true,flipSign:true},
  pcm_u24le:{bytes:3,sampleFormat:'s32',frameBytes:4,flipSign:true},
  pcm_u24be:{bytes:3,sampleFormat:'s32',frameBytes:4,bigEndian:true,flipSign:true},
  pcm_u32le:{bytes:4,sampleFormat:'s32',frameBytes:4,flipSign:true},
  pcm_u32be:{bytes:4,sampleFormat:'s32',frameBytes:4,bigEndian:true,flipSign:true},
  pcm_f32be:{bytes:4,sampleFormat:'flt',frameBytes:4,bigEndian:true},
  pcm_f64be:{bytes:8,sampleFormat:'dbl',frameBytes:8,bigEndian:true},
  pcm_alaw:{bytes:1,sampleFormat:'s16',frameBytes:2},
  pcm_mulaw:{bytes:1,sampleFormat:'s16',frameBytes:2},
  pcm_u8: { bytes: 1, sampleFormat: 'u8', frameBytes: 1 },
  pcm_s16le: { bytes: 2, sampleFormat: 's16', frameBytes: 2 },
  pcm_s24le: { bytes: 3, sampleFormat: 's32', frameBytes: 4 },
  pcm_s32le: { bytes: 4, sampleFormat: 's32', frameBytes: 4 },
  pcm_f32le: { bytes: 4, sampleFormat: 'flt', frameBytes: 4 },
  pcm_f64le: { bytes: 8, sampleFormat: 'dbl', frameBytes: 8 }
};
export function getPcmFormat(codec: PcmCodec) {
  const spec = encoding(codec);
  return Object.freeze({ bytesPerSample: spec.bytes, frameBytesPerSample: spec.frameBytes, sampleFormat: spec.sampleFormat });
}
export function isPcmCodec(codec:string):codec is PcmCodec{return Object.hasOwn(formats,codec);}
export function isIntegerPcm(codec: PcmCodec): boolean {const format=encoding(codec).sampleFormat;return format!=='flt'&&format!=='dbl';}
function encoding(codec: PcmCodec) {
  if (!Object.hasOwn(formats, codec)) throw new PcmError('Unsupported PCM codec');
  return formats[codec];
}
function checkSize(bytes: number, options: PcmOptions): void {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes <= 0 || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > options.maxFrameBytes) throw new PcmError('PCM frame exceeds allocation limit');
}
function checkFormat(channels: number, sampleRate: number): void {
  if (!Number.isSafeInteger(channels) || channels <= 0 || !Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new PcmError('Invalid PCM channels or sample rate');
}
/** Packed little-endian frames. Signed8 becomes biased u8; 24-bit words expand to left-justified s32. */
export function decodePcm(packet: MediaPacket, format: PcmFormat, options: PcmOptions): AudioFrameData {
  checkFormat(format.channels, format.sampleRate);
  if(isG711Codec(format.codec))return decodeG711(packet,{...format,codec:format.codec},options);
  const spec = encoding(format.codec), block = spec.bytes * format.channels;
  if (packet.data.length % block !== 0 || packet.timeBase.num <= 0n || packet.timeBase.den <= 0n) throw new PcmError('Invalid PCM packet alignment or time base');
  const samples = packet.data.length / block, count = samples * format.channels;
  checkSize(count * spec.frameBytes, options);
  const data = new Uint8Array(count * spec.frameBytes);
  if(spec.bytes===spec.frameBytes&&!spec.bigEndian&&!spec.flipSign)data.set(packet.data);
  else for(let i=0;i<count;i++){
    if((i&4095)===0)options.signal?.throwIfAborted();
    const padding=spec.frameBytes-spec.bytes;
    for(let j=0;j<spec.bytes;j++)data[i*spec.frameBytes+padding+j]=packet.data[i*spec.bytes+(spec.bigEndian?spec.bytes-1-j:j)]!;
    if(spec.flipSign)data[(i+1)*spec.frameBytes-1]=data[(i+1)*spec.frameBytes-1]!^128;
  }
  return { sampleRate: format.sampleRate, channels: format.channels, channelLayout: format.channelLayout ?? (format.channels === 1 ? 'mono' : format.channels === 2 ? 'stereo' : 'unspecified'), sampleFormat: spec.sampleFormat, samples, planes: [data], pts: packet.pts === null ? null : { value: packet.pts, timeBase: { ...packet.timeBase } } };
}
/** Integer bit-depth conversion truncates low bits; no dither, resampling or channel remix. */
export function encodePcm(frame: AudioFrameData, codec: PcmCodec, options: PcmOptions): MediaPacket {
  checkFormat(frame.channels, frame.sampleRate);
  if(isG711Codec(codec))return encodeG711(frame,codec,options);
  const target = encoding(codec);
  if (!Number.isSafeInteger(frame.samples) || frame.samples <= 0) throw new PcmError('Invalid PCM sample count');
  const count = frame.samples * frame.channels;
  checkSize(count * target.bytes, options);
  const native = frame.sampleFormat === target.sampleFormat ? frame : convertAudioFrame(frame, target.sampleFormat, options);
  if (native.planes.length !== 1 || native.planes[0]!.length !== count * target.frameBytes) throw new PcmError('Invalid packed PCM frame');
  const data = new Uint8Array(count * target.bytes), input = native.planes[0]!;
  if(target.bytes===target.frameBytes&&!target.bigEndian&&!target.flipSign)data.set(input);
  else for(let i=0;i<count;i++){
    if((i&4095)===0)options.signal?.throwIfAborted();
    const padding=target.frameBytes-target.bytes;
    for(let j=0;j<target.bytes;j++){
      const value=input[i*target.frameBytes+padding+(target.bigEndian?target.bytes-1-j:j)]!;
      data[i*target.bytes+j]=target.flipSign&&j===(target.bigEndian?0:target.bytes-1)?value^128:value;
    }
  }
  const timeBase = { num: 1n, den: BigInt(frame.sampleRate) };
  const pts = frame.pts === null ? null : rescale(frame.pts.value, frame.pts.timeBase, timeBase);
  return { streamIndex: 0, data, pts, dts: pts, duration: BigInt(frame.samples), timeBase, flags: 1 };
}
export { decodeG711, encodeG711, isG711Codec, G711Error } from './g711.js';
export type { G711Codec, G711Format, G711Options } from './g711.js';
export {decodeRawVideo,encodeRawVideo,RawVideoCodecError} from './raw-video.js';
export type {RawVideoCodecOptions,RawVideoFrameFormat} from './raw-video.js';

export {decodeBmp,encodeBmp,BmpError} from './bmp.js';
export type {BmpOptions} from './bmp.js';

/** Bounded H264 decoding with an explicitly supplied trusted precompiled module. */
export {createH264Decoder,validateH264DecoderOptions} from './h264/decoder.js';
export type {H264DecoderOptions} from './h264/decoder.js';
export type {H264DecodedFrame,H264VideoParameters} from './h264/decode-order.js';
export {createAvcDecoder,parseAvcConfiguration,avcPacketToAnnexB} from './h264/avcc.js';
export type {AvcConfiguration} from './h264/avcc.js';
export {H264InputError,H264ResourceError} from './h264/sps.js';

export type {H264Resource} from './h264/errors.mjs';

/** Bounded parameter inspection without loading a decoder module. */
export {inspectH264AnnexB,H264ParameterSets} from './h264/sps.js';
export type {H264Inspection,H264Sps} from './h264/sps.js';

export {parseFlacHeaderCandidate} from './flac/header.js';
export {createFlacDescriptorParser} from './flac/parser.js';
export {FlacWindowLimitError} from './flac/graph.js';
export type {FlacFrameHeader,FlacHeaderResult,FlacHeaderCandidate,FlacDiscoveryRequest,FlacParserOptions,FlacPacketRange,FlacParserResult,FlacParserMetrics,FlacDescriptorParser} from './flac/types.js';
export {updateFlacCrc16} from './flac/crc.js';

export {createFlacDecoder} from './flac/decoder.js';
export type {FlacDecoder,FlacDecoderInput,FlacDecoderOptions,FlacDecoderMetadata,FlacDecoderResult,FlacDecodedFrame} from './flac/decoder-types.js';

export {PARSER_FLAG_COMPLETE_FRAMES,PARSER_FLAG_USE_CODEC_TS} from './flac/parser.js';
export type {FlacParserFlags,FlacParserInput,FlacCompleteHeader,FlacCompleteHeaderRequest} from './flac/types.js';
