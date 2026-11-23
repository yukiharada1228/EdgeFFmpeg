import { expect, it } from 'vitest';
import { openWav, muxWav } from '@edge-ffmpeg/containers';
import type { MediaPacket } from '@edge-ffmpeg/core';
import { collectingOutput } from '../helpers/output.js';
import { memoryInput } from '../helpers/wav.js';
function packet(data = new Uint8Array([1,0,2,0])): MediaPacket {
  return { streamIndex: 0, data, pts: 0n, dts: 0n, duration: BigInt(data.length / 2), timeBase: { num: 1n, den: 8000n }, flags: 1 };
}
async function* packets(value = packet()) { yield value; }
const format = { codec: 'pcm_s16le', channels: 1, sampleRate: 8000 } as const;
it('writes finite PCM WAV in bounded chunks and commits after all bytes', async () => {
  const sink = collectingOutput();
  await muxWav(sink.output, format, packets(), { sampleCount: 2n, maxWriteBytes: 3 });
  expect(sink.committed).toBe(true); expect(sink.aborted).toBe(false);
  expect(sink.lengths.every(length => length <= 3)).toBe(true);
  const input = await openWav(memoryInput(sink.bytes()), { maxReadBytes: 4 });
  expect(input.info).toMatchObject({ codec: 'pcm_s16le', durationSamples: 2n });
  expect((await input.packets()[Symbol.asyncIterator]().next()).value?.data).toEqual(packet().data);
});
it('adds RIFF padding for odd unsigned PCM data', async () => {
  const sink = collectingOutput(), value = packet(new Uint8Array([128,129])); value.data = new Uint8Array([128,129,130]); value.duration = 3n;
  await muxWav(sink.output, { ...format, codec: 'pcm_u8' }, packets(value), { sampleCount: 3n, maxWriteBytes: 8 });
  const bytes = sink.bytes(); expect(bytes.length % 2).toBe(0); expect(bytes.at(-1)).toBe(0);
  const input = await openWav(memoryInput(bytes), { maxReadBytes: 8 }); expect(input.info.dataBytes).toBe(3n);
});
it('aborts on wrong lengths, timestamps or stream index without committing', async () => {
  for (const value of [{ ...packet(), pts: 1n }, { ...packet(), duration: 3n }, { ...packet(), streamIndex: 1 }, { ...packet(), timeBase: { num: 0n, den: 1n } }, { ...packet(), data: new Uint8Array(3) }]) {
    const sink = collectingOutput();
    await expect(muxWav(sink.output, format, packets(value), { sampleCount: 2n, maxWriteBytes: 8 })).rejects.toThrow();
    expect(sink.aborted).toBe(true); expect(sink.committed).toBe(false); expect(sink.bytes().length).toBe(0);
  }
  for (const count of [1n, 3n]) {
    const sink = collectingOutput();
    await expect(muxWav(sink.output, format, packets(), { sampleCount: count, maxWriteBytes: 8 })).rejects.toThrow();
    expect(sink.aborted).toBe(true);
  }
});
it('closes the input iterator and aborts output when writing fails', async () => {
  let finalized = false, aborted = false, writes = 0;
  async function* source() { try { yield packet(); } finally { finalized = true; } }
  await expect(muxWav({ async write() { if (++writes > 1) throw new Error('write failed'); }, async commit() { throw new Error('must not commit'); }, async abort() { aborted = true; } }, format, source(), { sampleCount: 2n, maxWriteBytes: 1024 })).rejects.toThrow('write failed');
  expect(finalized).toBe(true); expect(aborted).toBe(true);
});
it('preserves failures from both the operation and output abort', async () => {
  await expect(muxWav({ async write() { throw new Error('write'); }, async commit() {}, async abort() { throw new Error('abort'); } }, format, packets(), { sampleCount: 2n, maxWriteBytes: 8 })).rejects.toBeInstanceOf(AggregateError);
});
it('checks cancellation before output and rejects RIFF overflow', async () => {
  const abort = new AbortController(); abort.abort('stop');
  const sink = collectingOutput();
  await expect(muxWav(sink.output, format, packets(), { sampleCount: 2n, maxWriteBytes: 8, signal: abort.signal })).rejects.toBe('stop');
  expect(sink.aborted).toBe(true);
  const overflow = collectingOutput();
  await expect(muxWav(overflow.output, format, packets(), { sampleCount: 0xffffffffn, maxWriteBytes: 8 })).rejects.toThrow('RF64');
  expect(overflow.aborted).toBe(true);
});
it('does not pull the next packet while an output write is blocked', async () => {
  let release = () => {}, notify = () => {}, produced = 0, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { notify = resolve; });
  const sink = collectingOutput();
  async function* source() {
    produced++; yield packet();
    produced++; yield { ...packet(), pts: 2n, dts: 2n };
  }
  const work = muxWav({ ...sink.output, async write(bytes) {
    if (++writes === 2) { notify(); await gate; }
    await sink.output.write(bytes);
  } }, format, source(), { sampleCount: 4n, maxWriteBytes: 1024 });
  await blocked; expect(produced).toBe(1); expect(sink.committed).toBe(false);
  release(); await work;
  expect(produced).toBe(2); expect(sink.committed).toBe(true);
});
it('writes an empty WAV and aborts when commit fails', async () => {
  const sink = collectingOutput();
  async function* empty(): AsyncIterable<MediaPacket> { /* valid empty stream */ }
  await muxWav(sink.output, format, empty(), { sampleCount: 0n, maxWriteBytes: 8 });
  expect(sink.committed).toBe(true);
  expect((await openWav(memoryInput(sink.bytes()), { maxReadBytes: 8 })).info.durationSamples).toBe(0n);
  const failure = collectingOutput();
  await expect(muxWav({ ...failure.output, async commit() { throw new Error('commit failed'); } }, format, packets(), { sampleCount: 2n, maxWriteBytes: 8 })).rejects.toThrow('commit failed');
  expect(failure.aborted).toBe(true);
});
