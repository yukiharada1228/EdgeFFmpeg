import { expect, it } from 'vitest';
import { ResourceContext } from '@edge-ffmpeg/core';
it('enforces total allocation and recovers released capacity once', () => {
  const context = new ResourceContext({ maxResidentBytes: 10, maxBufferBytes: 6, maxCpuTimeMs: 1, maxPendingPackets: 1 }, new AbortController().signal);
  const first = context.allocate(6);
  expect(() => context.allocate(5)).toThrow('budget');
  context.allocate(4);
  first.release(); first.release();
  expect(context.allocatedBytes).toBe(4);
  expect(context.allocate(6).data.length).toBe(6);
});
it('stops allocation after cancellation', () => {
  const abort = new AbortController(); abort.abort();
  const context = new ResourceContext({ maxResidentBytes: 10, maxBufferBytes: 6, maxCpuTimeMs: 1, maxPendingPackets: 1 }, abort.signal);
  expect(() => context.allocate(1)).toThrow();
});
