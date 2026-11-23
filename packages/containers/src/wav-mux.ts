import {muxerSoftware} from './reference-metadata.js';
import type {ReferenceMetadataProfile} from './reference-metadata.js';
import type { WriteHandle } from '@edge-ffmpeg/core';
import type { MediaPacket, PcmCodec } from '@edge-ffmpeg/avutil';
import { WavError } from './wav.js';
export type WavPcmCodec = Extract<PcmCodec,'pcm_u8'|'pcm_s16le'|'pcm_s24le'|'pcm_s32le'|'pcm_f32le'|'pcm_f64le'|'pcm_alaw'|'pcm_mulaw'>;
export interface WavOutputFormat {
  readonly codec: WavPcmCodec;
  readonly channels: number;
  readonly sampleRate: number;
  /** Use bigint for masks above32bits;only the explicit Native profile accepts them. */
  readonly channelMask?: number | bigint | null;
}
export interface WavMuxOptions { readonly sampleCount: bigint; readonly metadataProfile?: ReferenceMetadataProfile; readonly bitexact?:boolean; readonly maxWriteBytes: number; readonly signal?: AbortSignal }
const formats: Record<WavPcmCodec, { bits: number; tag: number }> = {
  pcm_alaw:{bits:8,tag:6},pcm_mulaw:{bits:8,tag:7},
  pcm_u8: { bits: 8, tag: 1 }, pcm_s16le: { bits: 16, tag: 1 }, pcm_s24le: { bits: 24, tag: 1 },
  pcm_s32le: { bits: 32, tag: 1 }, pcm_f32le: { bits: 32, tag: 3 }, pcm_f64le: { bits: 64, tag: 3 }
};
export function supportsWavCodec(codec:string):codec is WavPcmCodec{return Object.hasOwn(formats,codec);}
function layout(format: WavOutputFormat, samples: bigint, metadataProfile?:ReferenceMetadataProfile,bitexact=false) {
  const encoding = Object.hasOwn(formats, format.codec) ? formats[format.codec] : undefined;
  if (!encoding) throw new WavError('unsupported', 'Unsupported WAV output codec');
  const { bits, tag } = encoding;
  const { channels, sampleRate } = format;
  const blockAlign = channels * bits / 8, byteRate = sampleRate * blockAlign;
  if (!Number.isInteger(channels) || channels < 1 || channels > 0xffff || !Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0xffffffff || blockAlign > 0xffff || byteRate > 0xffffffff || typeof samples!=='bigint' || samples < 0n) throw new WavError('invalid-data', 'Invalid WAV output format or duration');
  const native=metadataProfile!==undefined,declaredMask=format.channelMask??0;
  if(typeof declaredMask!=='bigint'&&(!Number.isInteger(declaredMask)||declaredMask<0||declaredMask>0xffffffff))throw new WavError('invalid-data','Invalid WAV channel mask');
  const mask=typeof declaredMask==='bigint'?declaredMask:BigInt(declaredMask);
  if(mask<0n||mask>(native?0xffffffffffffffffn:0xffffffffn))throw new WavError('invalid-data','Invalid WAV channel mask');
  // Extensible preserves explicit channel masks and larger/multichannel PCM formats.
  // Scoped reference RIFF layout fields; see NOTICE-REFERENCE-METADATA.
  const canonicalMask=channels===1?4n:channels===2?3n:0n;
  const extensible = native ? mask!==0n&&mask!==canonicalMask||sampleRate>48000||bits>16&&tag!==3 : mask !== 0n || channels > 2 || bits > 16;
  const fmtSize = extensible ? 40 : tag !== 1 ? 18 : 16;
  const factSize = tag !== 1 ? 12 : 0;
  const software=muxerSoftware(metadataProfile),softwareBytes=software.length+1,paddedSoftwareBytes=softwareBytes+(softwareBytes&1),infoBodyBytes=12+paddedSoftwareBytes,infoSize=metadataProfile===undefined||bitexact?0:8+infoBodyBytes;
  const headerBytes=12+8+fmtSize+factSize+infoSize+8;
  const dataBytes = samples * BigInt(blockAlign);
  const riffSize = BigInt(headerBytes - 8) + dataBytes + (dataBytes & 1n);
  if (dataBytes >= 0xffffffffn || riffSize >= 0xffffffffn || (tag !== 1 && samples > 0xffffffffn)) throw new WavError('unsupported', 'WAV output requires RF64 size support');
  // Size fields native rewrites in its seekable trailer: RIFF at 4, fact count, data size.
  const factOffset=tag!==1?28+fmtSize:null,dataSizeOffset=headerBytes-4;
  return {bits,tag,channels,sampleRate,blockAlign,byteRate,native,mask,extensible,fmtSize,software,softwareBytes,infoBodyBytes,infoSize,headerBytes,dataBytes,riffSize,factOffset,dataSizeOffset};
}
export {layout as wavLayout};
/** Validate the exact finite RIFF header without allocating bytes or opening a writer. */
export function validateWavOutput(format:WavOutputFormat,samples:bigint,options:Pick<WavMuxOptions,'metadataProfile'|'bitexact'>={}):void{
  layout({...format},samples,options.metadataProfile,options.bitexact);
}
/** `placeholder` writes the values native emits before its seekable trailer rewrites them. */
function header(format: WavOutputFormat, samples: bigint, metadataProfile?:ReferenceMetadataProfile,bitexact=false,placeholder=false): { bytes: Uint8Array; blockAlign: number; dataBytes: bigint } {
  const {bits,tag,channels,sampleRate,blockAlign,byteRate,native,mask,extensible,fmtSize,software,softwareBytes,infoBodyBytes,infoSize,headerBytes,dataBytes,riffSize}=layout(format,samples,metadataProfile,bitexact);
  const bytes=new Uint8Array(headerBytes),view=new DataView(bytes.buffer);
  function text(value: string, offset: number): void { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); }
  text('RIFF', 0); view.setUint32(4, placeholder?0xffffffff:Number(riffSize), true); text('WAVE', 8); text('fmt ', 12); view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : tag, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true); view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true); view.setUint16(38, bits, true); view.setUint32(40, Number(native&&mask>=0x40000n?0n:mask), true); view.setUint32(44, tag, true);
    bytes.set([0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 48);
  }
  let offset = 20 + fmtSize;
  if (tag !== 1) { text('fact', offset); view.setUint32(offset + 4, 4, true); view.setUint32(offset + 8, placeholder?0:wavFactSamples(native,samples), true); offset += 12; }
  if(infoSize){text('LIST',offset);view.setUint32(offset+4,infoBodyBytes,true);text('INFO',offset+8);text('ISFT',offset+12);view.setUint32(offset+16,softwareBytes,true);text(software,offset+20);offset+=infoSize;}
  text('data', offset); view.setUint32(offset + 4, placeholder?0xffffffff:Number(dataBytes), true);
  return { bytes, blockAlign, dataBytes };
}
export {header as wavHeader};
/** Fact count: native rescales maxpts-minpts+last_duration; with no packet the INT64_MAX minimum wraps to1. */
export const wavFactSamples=(native:boolean,samples:bigint):number=>native&&samples===0n?1:Number(samples);
/** Contiguous zero-based stream-zero packet timing; equivalent rational time bases are accepted. */
export function checkWavPacketTiming(packet:MediaPacket,written:bigint,blockAlign:number,sampleRate:number):void{
  const samplePosition = written / BigInt(blockAlign), duration = BigInt(packet.data.byteLength / blockAlign);
  const time = packet.timeBase;
  const matches = (value: bigint | null, expected: bigint): boolean => value !== null && value * time.num * BigInt(sampleRate) === expected * time.den;
  if (packet.streamIndex !== 0 || time.num <= 0n || time.den <= 0n || !matches(packet.pts, samplePosition) || !matches(packet.dts, samplePosition) || !matches(packet.duration, duration)) throw new WavError('invalid-data', 'Discontinuous or invalid PCM packet timestamps');
}
/** Finite PCM WAV mux. Owns the supplied output transaction and aborts it on any failure.
 * Input must be a single contiguous stream starting at sample zero. No input packets are retained.
 */
export async function muxWav(output: WriteHandle, format: WavOutputFormat, packets: AsyncIterable<MediaPacket>, options: WavMuxOptions): Promise<void> {
  try {
    const { signal, maxWriteBytes, sampleCount, metadataProfile, bitexact } = options;
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(maxWriteBytes) || maxWriteBytes <= 0) throw new WavError('resource-limit', 'Invalid WAV write limit');
    // Snapshot caller metadata before the first await.
    const stableFormat = { ...format };
    const { bytes, blockAlign, dataBytes } = header(stableFormat, sampleCount, metadataProfile, bitexact);
    async function write(bytes: Uint8Array): Promise<void> {
      for (let offset = 0; offset < bytes.length; offset += maxWriteBytes) {
        signal?.throwIfAborted();
        await output.write(bytes.subarray(offset, offset + maxWriteBytes));
        signal?.throwIfAborted();
      }
    }
    await write(bytes);
    let written = 0n;
    for await (const packet of packets) {
      signal?.throwIfAborted();
      const length = packet.data.byteLength;
      if (!length || length % blockAlign !== 0 || written + BigInt(length) > dataBytes) throw new WavError('invalid-data', 'Invalid PCM packet length');
      checkWavPacketTiming(packet, written, blockAlign, stableFormat.sampleRate);
      await write(packet.data); written += BigInt(length);
    }
    if (written !== dataBytes) throw new WavError('invalid-data', 'PCM byte count does not match declared duration');
    if (dataBytes & 1n) await write(new Uint8Array(1));
    signal?.throwIfAborted();
    await output.commit();
  } catch (error) {
    try { await output.abort(error); }
    catch (abortError) { throw new AggregateError([error, abortError], 'WAV mux failed and output abort failed'); }
    throw error;
  }
}
