import type { ReadHandle, WriteHandle } from '@edge-ffmpeg/core';
import type { MediaPacket, PcmCodec } from '@edge-ffmpeg/avutil';
const formats = {
  s8:{codec:'pcm_s8',bytes:1},
  s16be:{codec:'pcm_s16be',bytes:2},
  s24be:{codec:'pcm_s24be',bytes:3},
  s32be:{codec:'pcm_s32be',bytes:4},
  u16le:{codec:'pcm_u16le',bytes:2},
  u16be:{codec:'pcm_u16be',bytes:2},
  u24le:{codec:'pcm_u24le',bytes:3},
  u24be:{codec:'pcm_u24be',bytes:3},
  u32le:{codec:'pcm_u32le',bytes:4},
  u32be:{codec:'pcm_u32be',bytes:4},
  f32be:{codec:'pcm_f32be',bytes:4},
  f64be:{codec:'pcm_f64be',bytes:8},
  alaw:{codec:'pcm_alaw',bytes:1},mulaw:{codec:'pcm_mulaw',bytes:1},
  u8: { codec: 'pcm_u8', bytes: 1 }, s16le: { codec: 'pcm_s16le', bytes: 2 },
  s24le: { codec: 'pcm_s24le', bytes: 3 }, s32le: { codec: 'pcm_s32le', bytes: 4 },
  f32le: { codec: 'pcm_f32le', bytes: 4 }, f64le: { codec: 'pcm_f64le', bytes: 8 }
} as const;
export type RawPcmFormat = keyof typeof formats;
export class RawPcmError extends Error {}
export function rawPcmCodec(format: string): PcmCodec | null {
  return Object.hasOwn(formats, format) ? formats[format as RawPcmFormat].codec : null;
}
export interface RawPcmParameters { readonly codec: PcmCodec; readonly channels: number; readonly sampleRate: number; readonly channelMask?: number | null }
export interface RawPcmOptions extends RawPcmParameters { readonly maxReadBytes: number; readonly signal?: AbortSignal }
export interface RawPcmInfo {
  readonly codec: PcmCodec; readonly channels: number; readonly sampleRate: number; readonly channelMask: number | null;
  readonly bitsPerSample: number; readonly blockAlign: number; readonly dataOffset: bigint; readonly dataBytes: bigint; readonly durationSamples: bigint;
}
export interface RawPcmInput { readonly info: RawPcmInfo; packets(startSample?: bigint, maxPacketBytes?: number): AsyncIterable<MediaPacket> }
export interface RawPcmMuxOptions { readonly sampleCount: bigint; readonly maxWriteBytes: number; readonly signal?: AbortSignal }
function parameters(format: RawPcmParameters) {
  const spec = Object.values(formats).find(value => value.codec === format.codec);
  if (!spec || !Number.isInteger(format.channels) || format.channels < 1 || format.channels > 65535 || !Number.isInteger(format.sampleRate) || format.sampleRate < 1 || format.sampleRate > 2147483647) throw new RawPcmError('Invalid raw PCM parameters');
  const blockAlign = spec.bytes * format.channels;
  const defaults: Record<number,number> = { 3:0xb, 4:0x107, 5:0x37, 6:0x3f, 7:0x70f, 8:0x63f };
  const channelMask = format.channelMask === undefined ? defaults[format.channels] ?? null : format.channelMask;
  if (channelMask !== null && (!Number.isInteger(channelMask) || channelMask < 0 || channelMask > 0xffffffff)) throw new RawPcmError('Invalid raw PCM channel mask');
  return { blockAlign, bitsPerSample: spec.bytes * 8, channelMask };
}
/** Finite headerless PCM. Caller declarations are authoritative; bytes contain no format metadata. */
export async function openRawPcm(input: ReadHandle, options: RawPcmOptions): Promise<RawPcmInput> {
  const { codec, channels, sampleRate, maxReadBytes, signal } = options;
  signal?.throwIfAborted();
  const spec = parameters(options);
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < spec.blockAlign) throw new RawPcmError('A raw PCM sample frame exceeds the read budget');
  if (input.size < 0n || input.size % BigInt(spec.blockAlign) !== 0n) throw new RawPcmError('Incomplete raw PCM sample frame');
  const info: RawPcmInfo = Object.freeze({ codec, channels, sampleRate, ...spec, dataOffset: 0n, dataBytes: input.size, durationSamples: input.size / BigInt(spec.blockAlign) });
  const timeBase = Object.freeze({ num: 1n, den: BigInt(sampleRate) });
  return Object.freeze({ info,
    async *packets(startSample = 0n, maxPacketBytes = maxReadBytes): AsyncIterable<MediaPacket> {
      signal?.throwIfAborted();
      if (startSample < 0n || startSample > info.durationSamples) throw new RawPcmError('Raw PCM seek outside input');
      if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < spec.blockAlign || maxPacketBytes > maxReadBytes) throw new RawPcmError('Invalid raw PCM packet budget');
      const packetBytes = Math.floor(maxPacketBytes / spec.blockAlign) * spec.blockAlign;
      let position = startSample * BigInt(spec.blockAlign);
      while (position < info.dataBytes) {
        signal?.throwIfAborted();
        const length = Number(info.dataBytes - position < BigInt(packetBytes) ? info.dataBytes - position : BigInt(packetBytes));
        const data = new Uint8Array(length); let filled = 0;
        while (filled < length) {
          signal?.throwIfAborted();
          const chunk = await input.readAt(position + BigInt(filled), length - filled, signal);
          signal?.throwIfAborted();
          if (!chunk.length || chunk.length > length - filled) throw new RawPcmError('Unexpected raw PCM read length');
          data.set(chunk, filled); filled += chunk.length;
        }
        const pts = position / BigInt(spec.blockAlign);
        yield { streamIndex:0, data, pts, dts:pts, duration:BigInt(length / spec.blockAlign), timeBase, flags:1 };
        position += BigInt(length);
      }
    }
  });
}
/** Staged finite raw PCM output with byte-count/timestamp validation and sequential backpressure. */
export async function muxRawPcm(output: WriteHandle, format: RawPcmParameters, packets: AsyncIterable<MediaPacket>, options: RawPcmMuxOptions): Promise<void> {
  try {
    const spec = parameters(format), rate = BigInt(format.sampleRate), { sampleCount, maxWriteBytes, signal } = options;
    signal?.throwIfAborted();
    if (sampleCount < 0n || !Number.isSafeInteger(maxWriteBytes) || maxWriteBytes <= 0) throw new RawPcmError('Invalid raw PCM output limits');
    const expected = sampleCount * BigInt(spec.blockAlign); let written = 0n;
    for await (const packet of packets) {
      signal?.throwIfAborted();
      const length = packet.data.length;
      if (!length || length % spec.blockAlign !== 0 || written + BigInt(length) > expected) throw new RawPcmError('Invalid raw PCM output packet length');
      const time = packet.timeBase, position = written / BigInt(spec.blockAlign), duration = BigInt(length / spec.blockAlign);
      const matches = (value: bigint | null, expected: bigint) => value !== null && value * time.num * rate === expected * time.den;
      if (packet.streamIndex !== 0 || time.num <= 0n || time.den <= 0n || !matches(packet.pts, position) || !matches(packet.dts, position) || !matches(packet.duration, duration)) throw new RawPcmError('Invalid raw PCM output timestamps');
      for (let offset = 0; offset < length; offset += maxWriteBytes) {
        signal?.throwIfAborted(); await output.write(packet.data.subarray(offset, offset + maxWriteBytes)); signal?.throwIfAborted();
      }
      written += BigInt(length);
    }
    if (written !== expected) throw new RawPcmError('Raw PCM byte count does not match declared duration');
    signal?.throwIfAborted(); await output.commit();
  } catch (error) {
    try { await output.abort(error); } catch (abortError) { throw new AggregateError([error,abortError],'Raw PCM output and abort failed'); }
    throw error;
  }
}
