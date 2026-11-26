import {muxerSoftware} from './reference-metadata.js';
import type {ReferenceMetadataProfile} from './reference-metadata.js';
import type { WriteHandle } from '@edge-ffmpeg/core';
import type { MediaPacket, PcmCodec } from '@edge-ffmpeg/avutil';
import { rawPcmCodec } from './raw-pcm.js';
import { framePcmPackets, planPcmFraming } from './pcm-framing.js';
import type { PcmFraming } from './pcm-framing.js';

export class FrameCrcError extends Error {}
export interface FrameCrcAudioFormat {
  readonly codec: PcmCodec;
  readonly sampleRate: number;
  /** FFmpeg channel-layout description supplied by the stream planner. */
  readonly channelLayout: string;
}
export interface FrameCrcOptions {
  readonly maxWriteBytes: number;
  readonly bitexact?: boolean;
  readonly metadataProfile?: ReferenceMetadataProfile;
  readonly signal?: AbortSignal;
  /** Regroup contiguous zero-based PCM chunks without buffering a whole packet (framePcmPackets). */
  readonly framing?: PcmFraming;
}
/** Adler-32 with the framecrc seed (zero), independently defined by modular sums. */
export function frameCrcChecksum(data: Uint8Array,signal?:AbortSignal): number {
  return updateChecksum(data, 0,signal);
}
function updateChecksum(data: Uint8Array, seed: number,signal?:AbortSignal): number {
  let a = seed & 65535, b = seed >>> 16;
  for (let index=0;index<data.length;index++) { if((index&4095)===0)signal?.throwIfAborted();a = (a + data[index]!) % 65521; b = (b + a) % 65521; }
  return (b * 65536 + a) >>> 0;
}
const minInt64 = -(1n << 63n), maxInt64 = (1n << 63n) - 1n;
function integer(value: bigint | null): string {
  if (value !== null && (value < minInt64 || value > maxInt64)) throw new FrameCrcError('Timestamp exceeds signed 64-bit range');
  return String(value ?? minInt64);
}
/**
 * Single PCM audio stream framecrc output. Without framing, packet boundaries
 * are semantic input: the caller must supply encoder/demuxer framing, rather
 * than arbitrary I/O chunks. No extradata or side-data representation yet.
 */
export async function muxFrameCrc(output: WriteHandle, format: FrameCrcAudioFormat, packets: AsyncIterable<MediaPacket>, options: FrameCrcOptions): Promise<void> {
  try {
    const { maxWriteBytes, signal } = options;
    signal?.throwIfAborted();
    const software=muxerSoftware(options.metadataProfile);
    if (!Number.isSafeInteger(maxWriteBytes) || maxWriteBytes < 1 || !Number.isInteger(format.sampleRate) || format.sampleRate < 1 || format.sampleRate > 2147483647 || rawPcmCodec(format.codec.slice(4)) !== format.codec || !/^[a-zA-Z0-9 .()+_-]{1,128}$/.test(format.channelLayout)) throw new FrameCrcError('Invalid framecrc audio parameters');
    const framing = options.framing&&planPcmFraming(options.framing,'framecrc',message=>new FrameCrcError(message));
    const encoder = new TextEncoder();
    const write = async (text: string) => {
      const bytes = encoder.encode(text);
      for (let offset = 0; offset < bytes.length; offset += maxWriteBytes) {
        signal?.throwIfAborted();
        await output.write(bytes.subarray(offset, offset + maxWriteBytes));
        signal?.throwIfAborted();
      }
    };
    if (!options.bitexact) await write('#software: '+software+'\n');
    await write(`#tb 0: 1/${format.sampleRate}\n#media_type 0: audio\n#codec_id 0: ${format.codec}\n#sample_rate 0: ${format.sampleRate}\n#channel_layout_name 0: ${format.channelLayout}\n`);
    const row = async (dts: bigint | null, pts: bigint | null, duration: bigint | null, size: number, crc: number, flags: number) => {
      const suffix = flags === 1 ? '' : `, F=0x${flags.toString(16).toUpperCase()}`;
      await write(`0, ${integer(dts).padStart(10)}, ${integer(pts).padStart(10)}, ${integer(duration ?? 0n).padStart(8)}, ${String(size).padStart(8)}, 0x${crc.toString(16).padStart(8,'0')}${suffix}\n`);
    };
    async function* checked(){
      for await (const packet of packets) {
        signal?.throwIfAborted();
        if (packet.streamIndex !== 0 || packet.timeBase.num <= 0n || packet.timeBase.den !== packet.timeBase.num * BigInt(format.sampleRate) || !Number.isInteger(packet.flags) || packet.flags < 0 || packet.flags > 0x7fffffff || packet.data.length > 0x7fffffff) throw new FrameCrcError('Invalid framecrc packet');
        yield packet;
      }
    }
    if (!framing) {
      for await (const packet of checked()) await row(packet.dts,packet.pts,packet.duration,packet.data.length,frameCrcChecksum(packet.data,signal),packet.flags);
    } else {
      let checksum = 0;
      for await (const chunk of framePcmPackets(framing,checked(),signal)) {
        checksum = updateChecksum(chunk.bytes,checksum,signal);
        if (chunk.end) { await row(chunk.pts,chunk.pts,chunk.duration,Number(chunk.duration) * framing.blockAlign,checksum,1); checksum = 0; }
      }
    }
    signal?.throwIfAborted();
    await output.commit();
  } catch (error) {
    try { await output.abort(error); } catch (abortError) { throw new AggregateError([error,abortError],'Framecrc output and abort failed'); }
    throw error;
  }
}
