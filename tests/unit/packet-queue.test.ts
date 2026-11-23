import { expect, it } from 'vitest';
import { PacketQueue } from '@edge-ffmpeg/core';
it('reserves capacity before producing data and resumes in FIFO order', async () => {
  const queue = new PacketQueue<number>(2, () => {}, new AbortController().signal);
  const a = await queue.reserve(), b = await queue.reserve();
  expect(queue.pendingPackets).toBe(2);
  let resumed = false;
  const waiting = queue.reserve().then(slot => { resumed = true; return slot; });
  await Promise.resolve(); expect(resumed).toBe(false);
  a.publish(1); b.publish(2);
  expect(await queue.next()).toEqual({ value: 1, done: false });
  const c = await waiting; c.publish(3);
  expect(queue.pendingPackets).toBe(2);
  queue.close();
  expect(await queue.next()).toEqual({ value: 2, done: false });
  expect(await queue.next()).toEqual({ value: 3, done: false });
  expect(await queue.next()).toEqual({ value: undefined, done: true });
});
it('releases reservations once and bounds pending producer operations', async () => {
  const queue = new PacketQueue<number>(1, () => {}, new AbortController().signal, 1);
  const slot = await queue.reserve();
  const waiting = queue.reserve();
  await expect(queue.reserve()).rejects.toThrow('Too many');
  slot.release(); slot.release();
  const next = await waiting;
  expect(queue.pendingPackets).toBe(1);
  expect(() => slot.publish(1)).toThrow('active');
  next.release(); queue.close();
});
it('cancellation disposes queued packets and rejects blocked producers', async () => {
  const abort = new AbortController(), discarded: number[] = [];
  const queue = new PacketQueue<number>(1, n => { discarded.push(n); }, abort.signal);
  (await queue.reserve()).publish(7);
  const waiting = expect(queue.reserve()).rejects.toBe('stop');
  abort.abort('stop');
  await waiting;
  expect(discarded).toEqual([7]);
  await expect(queue.next()).rejects.toBe('stop');
  queue.cancel(); expect(discarded).toEqual([7]);
});
it('wakes readers, rejects concurrent reads and closes an empty queue', async () => {
  const queue = new PacketQueue<number>(1, () => {}, new AbortController().signal);
  const reading = queue.next();
  await expect(queue.next()).rejects.toThrow('Concurrent');
  (await queue.reserve()).publish(4);
  expect(await reading).toEqual({ value: 4, done: false });
  const done = queue.next(); queue.close();
  expect(await done).toEqual({ done: true, value: undefined });
});
it('cleans up on early consumer exit and rejects revoked reservations', async () => {
  const discarded: number[] = [];
  const queue = new PacketQueue<number>(3, n => { discarded.push(n); }, new AbortController().signal);
  (await queue.reserve()).publish(1); (await queue.reserve()).publish(2);
  const reserved = await queue.reserve();
  for await (const value of queue) { expect(value).toBe(1); break; }
  expect(discarded).toEqual([2]);
  expect(() => reserved.publish(3)).toThrow('active');
  expect(queue.pendingPackets).toBe(0);
});
it('cancels a blocked reader and handles an already aborted signal', async () => {
  const abort = new AbortController();
  const queue = new PacketQueue<number>(1, () => {}, abort.signal);
  const blocked = expect(queue.next()).rejects.toBe('cancelled');
  abort.abort('cancelled'); await blocked;
  const second = new PacketQueue<number>(1, () => {}, abort.signal);
  await expect(second.reserve()).rejects.toBe('cancelled');
});
it('discards packets still draining after close when cancellation arrives', async () => {
  const abort = new AbortController(), discarded: number[] = [];
  const queue = new PacketQueue<number>(1, n => { discarded.push(n); }, abort.signal);
  (await queue.reserve()).publish(9); queue.close(); abort.abort('stop');
  expect(discarded).toEqual([9]);
  await expect(queue.next()).rejects.toBe('stop');
});
it('continues cleanup when a disposer throws and reports all failures', async () => {
  const discarded: number[] = [];
  const queue = new PacketQueue<number>(2, value => { discarded.push(value); throw new Error('cleanup'); }, new AbortController().signal);
  (await queue.reserve()).publish(1); (await queue.reserve()).publish(2);
  const blocked = expect(queue.reserve()).rejects.toBeInstanceOf(AggregateError);
  queue.cancel('stop'); await blocked;
  expect(discarded).toEqual([1, 2]);
  expect(queue.pendingPackets).toBe(0);
});
