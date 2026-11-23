// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapts fftools/thread_queue.c at the locked FFmpeg commit. See ../NOTICE.
export interface ThreadFrameLease<T> {
  readonly value: T;
  readonly bytes: number;
  release(): void;
}
export interface ThreadFrameQueueOptions {
  readonly maxFrames: number;
  readonly maxBytes: number;
  readonly maxWaiters?: number;
}
export interface ThreadFrameQueueResult<T> {
  readonly code: number | 'again';
  readonly stream: number;
  readonly lease?: ThreadFrameLease<T>;
}
const EOF = -541478725, EINVAL = -22;
/** Owned cross-stream FIFO with per-stream finish markers and cooperative waits.
 * Successful sends transfer ownership; blocked/rejected sends leave it with the caller.
 * Returned leases belong to the receiver, which must release them exactly once.
 */
export function createThreadFrameQueue<T>(streams: number, options: ThreadFrameQueueOptions) {
  const settings = {...options, maxWaiters: options.maxWaiters ?? 64};
  if (!Number.isInteger(streams) || streams < 1 || streams > 33 ||
      ![settings.maxFrames, settings.maxBytes, settings.maxWaiters].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Invalid thread frame queue limits');
  }
  const finished = Array<number>(streams).fill(0);
  const fifo: {stream: number; lease: ThreadFrameLease<T>}[] = [];
  const waiters = new Set<() => void>(), cleanup: unknown[] = [];
  let choked = false, bytes = 0, disposed = false;
  let fault: {error: unknown} | undefined, disposalError: AggregateError | undefined;
  const valid = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= streams) throw new Error('Invalid thread queue stream');
  };
  const active = () => {
    if (fault) throw fault.error;
    if (disposed) throw new Error('Thread frame queue disposed');
  };
  const notify = () => { for (const wake of [...waiters]) wake(); };
  const wait = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    if (waiters.size >= settings.maxWaiters) { reject(new Error('Thread queue waiter budget exceeded')); return; }
    const clear = () => { waiters.delete(wake); signal?.removeEventListener('abort', abort); };
    const wake = () => { clear(); resolve(); }, abort = () => { clear(); reject(signal!.reason); };
    waiters.add(wake);
    signal?.addEventListener('abort', abort, {once: true});
  });
  const trySend = (index: number, lease: ThreadFrameLease<T>): number | 'blocked' => {
    active(); valid(index);
    if (finished[index]! & 1) return EINVAL;
    if (finished[index]! & 2) { finished[index]! |= 1; return EOF; }
    const size = lease.bytes, release = lease.release;
    if (!Number.isSafeInteger(size) || size < 0 || typeof release !== 'function') throw new Error('Invalid thread queue lease');
    if (size > settings.maxBytes) throw new Error('Thread queue frame exceeds byte budget');
    if (fifo.length >= settings.maxFrames || size > settings.maxBytes - bytes) return 'blocked';
    // Snapshot accounting and cleanup fields when ownership transfers. Payload
    // storage itself is borrowed from the transferred owner, not copied here.
    fifo.push({stream: index, lease: Object.freeze({value: lease.value, bytes: size, release: release.bind(lease)})});
    bytes += size; notify(); return 0;
  };
  const tryReceive = (): ThreadFrameQueueResult<T> => {
    active();
    if (choked) return {code: 'again', stream: -1};
    while (fifo.length) {
      const item = fifo.shift()!;
      bytes -= item.lease.bytes; notify();
      if (finished[item.stream]! & 2) {
        try { item.lease.release(); }
        catch (error) { cleanup.push(error); fault = {error}; notify(); throw error; }
        continue;
      }
      return {code: 0, stream: item.stream, lease: item.lease};
    }
    let count = 0;
    for (let index = 0; index < streams; index++) {
      if (!finished[index]) continue;
      if (!(finished[index]! & 2)) { finished[index]! |= 2; return {code: EOF, stream: index}; }
      count++;
    }
    return {code: count === streams ? EOF : 'again', stream: -1};
  };
  return {
    snapshot() { return Object.freeze({choked, finished: Object.freeze([...finished]), streams: Object.freeze(fifo.map(item => item.stream)), bytes}); },
    get cleanupErrors() { return Object.freeze([...cleanup]); },
    trySend, tryReceive,
    async send(index: number, lease: ThreadFrameLease<T>, signal?: AbortSignal) {
      for (;;) {
        signal?.throwIfAborted();
        const result = trySend(index, lease);
        if (result !== 'blocked') return result;
        await wait(signal);
      }
    },
    async receive(signal?: AbortSignal): Promise<ThreadFrameQueueResult<T>> {
      for (;;) {
        signal?.throwIfAborted();
        const result = tryReceive();
        if (result.code !== 'again') return result;
        await wait(signal);
      }
    },
    sendFinish(index: number) { active(); valid(index); finished[index]! |= 1; choked = false; notify(); },
    receiveFinish(index: number) { active(); valid(index); finished[index]! |= 2; notify(); },
    choke(value: boolean) {
      active();
      if (typeof value !== 'boolean') throw new Error('Invalid choke state');
      choked = value; notify();
    },
    /** Drops all queue-owned leases, attempts every release and wakes pending operations. */
    dispose() {
      if (disposed) { if (disposalError) throw disposalError; return; }
      disposed = true;
      for (const item of fifo.splice(0)) try { item.lease.release(); } catch (error) { cleanup.push(error); }
      bytes = 0; notify();
      if (cleanup.length) {
        disposalError = new AggregateError([...cleanup], 'Thread queue cleanup failed');
        throw disposalError;
      }
    }
  };
}
