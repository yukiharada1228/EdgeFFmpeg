import type { ReadHandle } from '@edge-ffmpeg/core';
export function chunk(id: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + data.length + (data.length & 1));
  bytes.set(new TextEncoder().encode(id)); new DataView(bytes.buffer).setUint32(4, data.length, true); bytes.set(data, 8);
  return bytes;
}
export function riff(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(12 + chunks.reduce((sum, data) => sum + data.length, 0));
  result.set(new TextEncoder().encode('RIFF')); new DataView(result.buffer).setUint32(4, result.length - 8, true);
  result.set(new TextEncoder().encode('WAVE'), 8);
  let offset = 12; for (const data of chunks) { result.set(data, offset); offset += data.length; }
  return result;
}
export function pcmFormat(channels = 1, sampleRate = 8000, bits = 16): Uint8Array {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setUint16(0, 1, true); view.setUint16(2, channels, true); view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * channels * bits / 8, true); view.setUint16(12, channels * bits / 8, true); view.setUint16(14, bits, true);
  return bytes;
}
export function memoryInput(bytes: Uint8Array, requests: Array<{ offset: bigint; length: number }> = []): ReadHandle {
  return { size: BigInt(bytes.length), async readAt(offset, length, signal) {
    signal?.throwIfAborted(); requests.push({ offset, length });
    return bytes.slice(Number(offset), Number(offset) + length);
  } };
}
