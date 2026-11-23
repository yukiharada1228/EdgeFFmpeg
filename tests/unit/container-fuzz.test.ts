import { expect, it } from 'vitest';
import type { ReadHandle } from '@edge-ffmpeg/core';
import { openWav, openAiff, openAu, WavError, AiffError, AuError, RawPcmError } from '@edge-ffmpeg/containers';
import { chunk, pcmFormat, riff } from '../helpers/wav.js';

function aiffFixture(): Uint8Array {
  const bytes = new Uint8Array(58), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'FORM'], [8, 'AIFF'], [12, 'COMM'], [38, 'SSND']] as const) bytes.set(new TextEncoder().encode(text), offset);
  view.setUint32(4, 50); view.setUint32(16, 18); view.setUint16(20, 1); view.setUint32(22, 3); view.setUint16(26, 8);
  bytes.set([0x40, 0x0b, 0xfa, 0, 0, 0, 0, 0, 0, 0], 28); view.setUint32(42, 11); bytes.set([128, 0, 127], 54);
  return bytes;
}
function auFixture(): Uint8Array {
  const bytes = new Uint8Array(35), view = new DataView(bytes.buffer);
  [0x2e736e64, 32, 3, 2, 8000, 1].forEach((value, index) => view.setUint32(index * 4, value)); bytes.set([128, 0, 127], 32);
  return bytes;
}
const formats = [
  { name: 'wav', bytes: riff([chunk('fmt ', pcmFormat()), chunk('JUNK', new Uint8Array([3])), chunk('data', new Uint8Array([1, 0, 2, 0]))]), open: openWav },
  { name: 'aiff', bytes: aiffFixture(), open: openAiff },
  { name: 'au', bytes: auFixture(), open: openAu }
];
function* mutations(original: Uint8Array): Generator<Uint8Array> {
  yield original;
  for (let length = 0; length < original.length; length++) yield original.slice(0, length);
  for (let offset = 0; offset + 4 <= original.length; offset += 4) for (const value of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
    const bytes = original.slice(); new DataView(bytes.buffer).setUint32(offset, value); yield bytes;
  }
  let state = 0x1258cafe;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let index = 0; index < 256; index++) {
    const bytes = original.slice(), count = 1 + next() % 4;
    for (let changed = 0; changed < count; changed++) bytes[next() % bytes.length] = next() >>> 24;
    yield bytes;
  }
}
it('bounds seeded WAV AIFF AU mutations and permits only explicit container failures', async () => {
  let cases = 0, decoded = 0;
  for (const format of formats) for (const bytes of mutations(format.bytes)) for (const limit of [1, 7, 32]) {
    const label = `${format.name}/${cases++}/${limit}`; let reads = 0;
    const input: ReadHandle = { size: BigInt(bytes.length), async readAt(offset, length) {
      expect(++reads, label).toBeLessThanOrEqual(512);
      expect(length, label).toBeGreaterThan(0); expect(length, label).toBeLessThanOrEqual(limit);
      expect(offset, label).toBeGreaterThanOrEqual(0n); expect(offset + BigInt(length), label).toBeLessThanOrEqual(BigInt(bytes.length));
      return bytes.slice(Number(offset), Number(offset) + Math.min(length, 1 + reads % 3));
    } };
    try {
      const demuxed = await format.open(input, { maxReadBytes: limit, maxChunks: 16 }); let emitted = 0, packets = 0;
      expect(demuxed.info.dataBytes, label).toBeLessThanOrEqual(BigInt(bytes.length));
      for await (const packet of demuxed.packets()) {
        expect(++packets, label).toBeLessThanOrEqual(bytes.length); expect(packet.data.length, label).toBeGreaterThan(0);
        expect(packet.data.length, label).toBeLessThanOrEqual(limit);
        emitted += packet.data.length; expect(emitted, label).toBeLessThanOrEqual(bytes.length);
      }
      expect(BigInt(emitted), label).toBe(demuxed.info.dataBytes); decoded++;
    } catch (error) {
      expect(error instanceof WavError || error instanceof AiffError || error instanceof AuError || error instanceof RawPcmError, `${label}: ${String(error)}`).toBe(true);
    }
  }
  expect(cases).toBe(3306); expect(decoded).toBeGreaterThan(3);
});

it('propagates cancellation from short header reads and packet reads in every finite audio container', async () => {
  for (const format of formats) {
    for (let abortAt = 1; abortAt <= 8; abortAt++) {
      const controller = new AbortController(), reason = new Error(`${format.name}/${abortAt}`); let reads = 0;
      const input: ReadHandle = { size: BigInt(format.bytes.length), async readAt(offset) {
        if (++reads === abortAt) controller.abort(reason);
        return format.bytes.slice(Number(offset), Number(offset) + 1);
      } };
      await expect(format.open(input, { maxReadBytes: 1, signal: controller.signal })).rejects.toBe(reason); expect(reads).toBe(abortAt);
    }
    const controller = new AbortController(), reason = new Error(`${format.name}/packet`); let media = false;
    const input: ReadHandle = { size: BigInt(format.bytes.length), async readAt(offset, length) {
      if (media) controller.abort(reason);
      return format.bytes.slice(Number(offset), Number(offset) + length);
    } };
    const demuxed = await format.open(input, { maxReadBytes: 4, signal: controller.signal }); media = true;
    await expect(demuxed.packets()[Symbol.asyncIterator]().next()).rejects.toBe(reason);
  }
});
