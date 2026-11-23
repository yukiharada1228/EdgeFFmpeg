import { expect, it } from 'vitest';
import { decodePcm, encodePcm } from '@edge-ffmpeg/avcodec';
import type { MediaPacket } from '@edge-ffmpeg/avutil';
const options = { maxFrameBytes: 1024 };
function packet(data: number[]): MediaPacket { return { streamIndex: 0, data: new Uint8Array(data), pts: 5n, dts: 5n, duration: null, timeBase: { num: 1n, den: 8000n }, flags: 1 }; }
it('expands signed 24-bit PCM without losing sign or low bits', () => {
  const frame = decodePcm(packet([0,0,0x80, 0xff,0xff,0x7f, 1,0,0, 0xff,0xff,0xff]), { codec: 'pcm_s24le', channels: 1, sampleRate: 8000 }, options);
  const view = new DataView(frame.planes[0]!.buffer);
  expect(frame.sampleFormat).toBe('s32'); expect(frame.samples).toBe(4);
  expect(Array.from({ length: 4 }, (_, i) => view.getInt32(i * 4, true))).toEqual([-2147483648,2147483392,256,-256]);
  const encoded = encodePcm(frame, 'pcm_s24le', options);
  expect([...encoded.data]).toEqual([0,0,0x80, 0xff,0xff,0x7f, 1,0,0, 0xff,0xff,0xff]); expect(encoded.pts).toBe(5n);
});
it('converts unsigned bias and truncates integer low bits', () => {
  const frame = decodePcm(packet([0,128,255]), { codec: 'pcm_u8', channels: 1, sampleRate: 8000 }, options);
  const signed = encodePcm(frame, 'pcm_s16le', options);
  expect([...signed.data]).toEqual([0,128,0,0,0,127]);
  const restored = encodePcm(decodePcm(signed, { codec: 'pcm_s16le', channels: 1, sampleRate: 8000 }, options), 'pcm_u8', options);
  expect([...restored.data]).toEqual([0,128,255]);
});
it('owns decoded/encoded buffers and preserves floating-point payload bits', () => {
  const source = packet([0x34,0x12,0xc0,0x7f]);
  const frame = decodePcm(source, { codec: 'pcm_f32le', channels: 1, sampleRate: 8000 }, options);
  const encoded = encodePcm(frame, 'pcm_f32le', options);
  expect(() => encodePcm(frame, 'pcm_s16le', options)).toThrow('Non-finite');
  source.data.fill(0); expect([...encoded.data]).toEqual([0x34,0x12,0xc0,0x7f]);
  frame.planes[0]!.fill(0); expect([...encoded.data]).toEqual([0x34,0x12,0xc0,0x7f]);
  expect([...encodePcm(frame, 'pcm_s16le', options).data]).toEqual([0,0]);
});
it('rejects malformed or oversized frames and cancellation', () => {
  expect(() => decodePcm(packet([1]), { codec: 'pcm_s16le', channels: 1, sampleRate: 8000 }, options)).toThrow('alignment');
  expect(() => decodePcm(packet([1,2,3]), { codec: 'pcm_s24le', channels: 1, sampleRate: 8000 }, { maxFrameBytes: 3 })).toThrow('allocation');
  const frame = decodePcm(packet([128]), { codec: 'pcm_u8', channels: 1, sampleRate: 8000 }, options);
  expect(() => encodePcm(frame, 'pcm_s32le', { maxFrameBytes: 3 })).toThrow('allocation');
  expect(() => encodePcm({ ...frame, planes: [] }, 'pcm_u8', options)).toThrow('packed');
  const abort = new AbortController(); abort.abort('stop');
  expect(() => decodePcm(packet([1]), { codec: 'pcm_u8', channels: 1, sampleRate: 8000 }, { ...options, signal: abort.signal })).toThrow();
});
