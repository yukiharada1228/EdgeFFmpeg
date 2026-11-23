import type { ReadHandle } from '@edge-ffmpeg/core';
import type { MediaPacket } from '@edge-ffmpeg/avutil';
export class WavError extends Error {
  constructor(readonly code: 'invalid-data' | 'unsupported' | 'resource-limit', message: string) { super(message); }
}
export interface WavOptions { readonly maxReadBytes: number; readonly maxChunks?: number; readonly signal?: AbortSignal }
export interface WavInfo {
  readonly codec: string; readonly channels: number; readonly sampleRate: number;
  readonly bitsPerSample: number; readonly blockAlign: number; readonly channelMask: number | null;
  readonly dataOffset: bigint; readonly dataBytes: bigint; readonly durationSamples: bigint;
}
export interface WavInput {
  readonly info: WavInfo;
  /** Starts at an exact sample frame. Packet boundaries depend on maxReadBytes. */
  packets(startSample?: bigint, maxPacketBytes?: number): AsyncIterable<MediaPacket>;
}
const fourcc = (data: Uint8Array, offset = 0): string => String.fromCharCode(...data.subarray(offset, offset + 4));
/** Independently implemented RIFF/WAVE reader. No FFmpeg source translation. */
export async function openWav(input: ReadHandle, options: WavOptions): Promise<WavInput> {
  const { maxReadBytes, signal } = options;
  const maxChunks = options.maxChunks ?? 4096;
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0 || !Number.isSafeInteger(maxChunks) || maxChunks <= 0) throw new WavError('resource-limit', 'Invalid WAV read limits');
  if (input.size < 12n) throw new WavError('invalid-data', 'Truncated RIFF header');
  async function readExact(offset: bigint, length: number): Promise<Uint8Array> {
    signal?.throwIfAborted();
    if (offset < 0n || offset + BigInt(length) > input.size) throw new WavError('invalid-data', 'Read exceeds input bounds');
    const result = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      signal?.throwIfAborted();
      const requested = Math.min(length - filled, maxReadBytes);
      const chunk = await input.readAt(offset + BigInt(filled), requested, signal);
      signal?.throwIfAborted();
      if (!chunk.length || chunk.length > requested) throw new WavError('invalid-data', 'Unexpected input read length');
      result.set(chunk, filled); filled += chunk.length;
    }
    return result;
  }
  const header = await readExact(0n, 12);
  if (['RF64', 'BW64', 'RIFX'].includes(fourcc(header))) throw new WavError('unsupported', 'Extended or big-endian WAV is not yet supported');
  if (fourcc(header) !== 'RIFF' || fourcc(header, 8) !== 'WAVE') throw new WavError('invalid-data', 'Expected RIFF/WAVE');
  const riffLength = new DataView(header.buffer).getUint32(4, true);
  if (riffLength === 0xffffffff) throw new WavError('unsupported', 'Streaming WAV with unknown size is not yet supported');
  const end = BigInt(riffLength) + 8n;
  if (end < 12n || end > input.size) throw new WavError('invalid-data', 'Invalid RIFF size');
  let format: Omit<WavInfo, 'dataOffset' | 'dataBytes' | 'durationSamples'> | undefined;
  let data: { offset: bigint; bytes: bigint } | undefined;
  let offset = 12n, chunks = 0;
  while (offset < end) {
    if (++chunks > maxChunks) throw new WavError('resource-limit', 'WAV chunk count exceeds limit');
    if (end - offset < 8n) throw new WavError('invalid-data', 'Truncated chunk header');
    const chunkHeader = await readExact(offset, 8);
    const id = fourcc(chunkHeader), length = new DataView(chunkHeader.buffer).getUint32(4, true);
    const payload = offset + 8n, next = payload + BigInt(length) + BigInt(length & 1);
    if (next > end) throw new WavError('invalid-data', 'WAV chunk exceeds RIFF bounds');
    if (id === 'fmt ') {
      if (format) throw new WavError('unsupported', 'Multiple WAV format chunks');
      if (data) throw new WavError('unsupported', 'Format chunk after audio data');
      if (length < 16) throw new WavError('invalid-data', 'Truncated WAV format');
      const bytes = await readExact(payload, Math.min(length, 40));
      const view = new DataView(bytes.buffer);
      let tag = view.getUint16(0, true);
      const channels = view.getUint16(2, true), sampleRate = view.getUint32(4, true);
      const byteRate = view.getUint32(8, true), blockAlign = view.getUint16(12, true), bitsPerSample = view.getUint16(14, true);
      let channelMask: number | null = null;
      if (tag === 0xfffe) {
        if (length < 40 || view.getUint16(16, true) < 22 || view.getUint16(16, true) + 18 > length) throw new WavError('invalid-data', 'Truncated extensible WAV format');
        const expectedSuffix = [0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
        if (!expectedSuffix.every((value, i) => bytes[28 + i] === value)) throw new WavError('unsupported', 'Unsupported WAV subtype GUID');
        tag = view.getUint32(24, true);
        const validBits = view.getUint16(18, true);
        if (validBits !== 0 && validBits !== bitsPerSample) throw new WavError('unsupported', 'Packed valid-bit WAV samples are not yet supported');
        const declaredMask = view.getUint32(20, true);
        channelMask = declaredMask.toString(2).replaceAll('0', '').length === channels ? declaredMask : null;
      }
      const supported = tag === 1 ? [8, 16, 24, 32] : tag === 3 ? [32, 64] : tag === 6 || tag === 7 ? [8] : [];
      if (!supported.includes(bitsPerSample)) throw new WavError('unsupported', `Unsupported WAV encoding: ${tag}/${bitsPerSample}`);
      if (!channels || !sampleRate || blockAlign !== channels * (bitsPerSample / 8) || byteRate !== sampleRate * blockAlign) throw new WavError('invalid-data', 'Invalid PCM alignment or sample rate');
      if (blockAlign > maxReadBytes) throw new WavError('resource-limit', 'A sample frame exceeds the read budget');
      const codec = tag === 6 ? 'pcm_alaw' : tag === 7 ? 'pcm_mulaw' : tag === 3 ? `pcm_f${bitsPerSample}le` : bitsPerSample === 8 ? 'pcm_u8' : `pcm_s${bitsPerSample}le`;
      format = { codec, channels, sampleRate, bitsPerSample, blockAlign, channelMask };
    } else if (id === 'data') {
      if (data) throw new WavError('unsupported', 'Multiple WAV data chunks');
      if (!format) throw new WavError('unsupported', 'WAV data before format');
      data = { offset: payload, bytes: BigInt(length) };
    }
    offset = next;
  }
  if (!format || !data) throw new WavError('invalid-data', 'Missing WAV format or data');
  if (data.bytes % BigInt(format.blockAlign) !== 0n) throw new WavError('invalid-data', 'Incomplete PCM sample frame');
  const info: WavInfo = Object.freeze({ ...format, dataOffset: data.offset, dataBytes: data.bytes, durationSamples: data.bytes / BigInt(format.blockAlign) });
  const timeBase = Object.freeze({ num: 1n, den: BigInt(info.sampleRate) });
  return Object.freeze({
    info,
    async *packets(startSample = 0n, maxPacketBytes = maxReadBytes): AsyncIterable<MediaPacket> {
      if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < info.blockAlign || maxPacketBytes > maxReadBytes) throw new WavError('resource-limit', 'Invalid WAV packet limit');
      const packetBytes = Math.floor(maxPacketBytes / info.blockAlign) * info.blockAlign;
      if (startSample < 0n || startSample > info.durationSamples) throw new WavError('invalid-data', 'Seek sample outside WAV data');
      let position = startSample * BigInt(info.blockAlign);
      while (position < info.dataBytes) {
        const length = Number(info.dataBytes - position < BigInt(packetBytes) ? info.dataBytes - position : BigInt(packetBytes));
        const bytes = await readExact(info.dataOffset + position, length);
        const pts = position / BigInt(info.blockAlign);
        yield { streamIndex: 0, data: bytes, pts, dts: pts, duration: BigInt(length / info.blockAlign), timeBase, flags: 1 };
        position += BigInt(length);
      }
    }
  });
}
