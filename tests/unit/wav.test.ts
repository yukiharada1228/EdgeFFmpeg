import { expect, it } from 'vitest';
import { openWav } from '@edge-ffmpeg/containers';
import { chunk, riff, pcmFormat, memoryInput } from '../helpers/wav.js';
const audio = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]);
const wav = () => riff([chunk('fmt ', pcmFormat()), chunk('JUNK', new Uint8Array([9])), chunk('data', audio)]);
it('reads only headers on open and emits bounded aligned PCM packets with sample timestamps', async () => {
  const requests: Array<{ offset: bigint; length: number }> = [];
  const input = await openWav(memoryInput(wav(), requests), { maxReadBytes: 4 });
  expect(input.info).toMatchObject({ codec: 'pcm_s16le', channels: 1, sampleRate: 8000, durationSamples: 5n, dataBytes: 10n });
  expect(requests.every(request => request.offset < input.info.dataOffset)).toBe(true);
  const packets = [];
  for await (const packet of input.packets()) packets.push(packet);
  expect(packets.map(packet => [...packet.data])).toEqual([[1,0,2,0],[3,0,4,0],[5,0]]);
  expect(packets.map(packet => [packet.pts, packet.dts, packet.duration])).toEqual([[0n,0n,2n],[2n,2n,2n],[4n,4n,1n]]);
  expect(requests.every(request => request.length <= 4)).toBe(true);
  expect(packets[0]?.timeBase).toEqual({ num: 1n, den: 8000n });
});
it('seeks to exact sample frames without reading prior media', async () => {
  const input = await openWav(memoryInput(wav()), { maxReadBytes: 8 });
  const packets = []; for await (const packet of input.packets(3n)) packets.push(packet);
  expect(packets.map(packet => [...packet.data])).toEqual([[4,0,5,0]]); expect(packets[0]?.pts).toBe(3n);
  await expect(input.packets(6n)[Symbol.asyncIterator]().next()).rejects.toThrow('outside');
});
it('supports short reads and empty data', async () => {
  const bytes = riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array())]);
  const handle = memoryInput(bytes);
  const input = await openWav({ size: handle.size, readAt: (offset, length) => handle.readAt(offset, Math.min(length, 1)) }, { maxReadBytes: 16 });
  expect(await input.packets()[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
});
it('rejects malformed lengths, alignment, excessive chunks and unsupported encodings', async () => {
  const truncated = wav().slice(0, -1);
  await expect(openWav(memoryInput(truncated), { maxReadBytes: 8 })).rejects.toThrow('RIFF size');
  await expect(openWav(memoryInput(wav()), { maxReadBytes: 8, maxChunks: 1 })).rejects.toThrow('chunk count');
  await expect(openWav(memoryInput(wav()), { maxReadBytes: 1 })).rejects.toThrow('sample frame');
  const invalid = pcmFormat(); new DataView(invalid.buffer).setUint16(12, 5, true);
  await expect(openWav(memoryInput(riff([chunk('fmt ', invalid), chunk('data', audio)])), { maxReadBytes: 8 })).rejects.toThrow('alignment');
  const compressed = pcmFormat(); new DataView(compressed.buffer).setUint16(0, 2, true);
  await expect(openWav(memoryInput(riff([chunk('fmt ', compressed), chunk('data', audio)])), { maxReadBytes: 8 })).rejects.toThrow('encoding');
  await expect(openWav(memoryInput(riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array([1]))])), { maxReadBytes: 8 })).rejects.toThrow('Incomplete');
  await expect(openWav(memoryInput(riff([chunk('fmt ', pcmFormat()), chunk('data', audio), chunk('data', audio)])), { maxReadBytes: 8 })).rejects.toThrow('Multiple');
});
it('checks cancellation between packets', async () => {
  const abort = new AbortController();
  const input = await openWav(memoryInput(wav()), { maxReadBytes: 4, signal: abort.signal });
  const iterator = input.packets()[Symbol.asyncIterator](); await iterator.next(); abort.abort('stop');
  await expect(iterator.next()).rejects.toBe('stop');
});
it('rejects oversized chunk claims before reading or allocating the payload', async () => {
  const bytes = wav(); new DataView(bytes.buffer).setUint32(16, 0xffffffff, true);
  const requests: Array<{ offset: bigint; length: number }> = [];
  await expect(openWav(memoryInput(bytes, requests), { maxReadBytes: 8 })).rejects.toThrow('RIFF bounds');
  expect(requests.every(request => request.length <= 8)).toBe(true);
});
it('reports premature EOF during packet reading', async () => {
  const bytes = wav(); let readable = true;
  const handle = memoryInput(bytes);
  const input = await openWav({ size: handle.size, readAt: (offset, length) => readable ? handle.readAt(offset, length) : Promise.resolve(new Uint8Array()) }, { maxReadBytes: 8 });
  readable = false;
  await expect(input.packets()[Symbol.asyncIterator]().next()).rejects.toThrow('read length');
});
it('explicitly rejects big-endian and extended-size WAV signatures', async () => {
  for (const signature of ['RF64', 'BW64', 'RIFX']) {
    const bytes = wav(); bytes.set(new TextEncoder().encode(signature));
    await expect(openWav(memoryInput(bytes), { maxReadBytes: 8 })).rejects.toThrow('not yet supported');
  }
});
