import {expect, it} from 'vitest';
import {rebuildAudioEdits} from '../../packages/containers/src/mp4/audio-edit.js';

it('bounds expanded AAC indexes before allocation and observes cancellation', () => {
  const old = {
    sizes: new Uint32Array([3, 4]),
    offsets: new BigUint64Array([100n, 103n]),
    dts: new BigInt64Array([0n, 1024n]),
    pts: new BigInt64Array([0n, 1024n]),
    durations: new Uint32Array([1024, 1024]),
    flags: new Uint8Array([1, 1]),
  };
  const edit = {
    mediaTime: 0n, duration: 4096n, delay: 0n,
    segments: [{mediaTime: 0n, duration: 2048n}, {mediaTime: 0n, duration: 2048n}],
  };
  // 8 bytes for source search, 128 for entries, 132 for four output
  // packets and 16 for the largest preroll buffer: exactly 284 bytes.
  const run = (maxSamples: number, maxAdditionalBytes: number, signal?: AbortSignal) =>
    rebuildAudioEdits(old, edit, 8000, 2048n, 1024, {
      maxSamples, maxAdditionalBytes, ...(signal ? {signal} : {}),
    });
  expect(() => run(3, 284)).toThrow(/expanded audio edit index limit/);
  expect(() => run(4, 283)).toThrow(/expanded audio edit index limit/);
  expect(() => run(4, 135)).toThrow(/audio edit metadata limit/);
  const result = run(4, 284);
  expect(result.additionalBytes).toBe(284);
  expect([...result.offsets]).toEqual([100n, 103n, 100n, 103n]);
  expect([...old.dts]).toEqual([0n, 1024n]);
  const controller = new AbortController();
  const reason = new Error('cancel expanded audio index');
  controller.abort(reason);
  expect(() => run(4, 284, controller.signal)).toThrow(reason);
});
