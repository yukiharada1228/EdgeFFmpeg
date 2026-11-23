export interface PacketReservation<T> {
  /** Transfers ownership to the queue. Throws without taking ownership if closed. */
  publish(value: T): void;
  release(): void;
}
/** Reserve before reading/decoding a packet. Queued + reserved slots never exceed capacity.
 * One consumer; waiting reservations carry no media data and are bounded separately.
 */
export class PacketQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #reservations = new Set<object>();
  #waiters: Array<{ resolve: (value: PacketReservation<T>) => void; reject: (reason: unknown) => void }> = [];
  #reader: { resolve: (value: IteratorResult<T>) => void; reject: (reason: unknown) => void } | undefined;
  #closed = false;
  #failure: { reason: unknown } | undefined;
  #onAbort: () => void;
  constructor(readonly capacity: number, private readonly discard: (value: T) => void, private readonly signal: AbortSignal, readonly maxWaiters = capacity) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || !Number.isSafeInteger(maxWaiters) || maxWaiters <= 0) throw new RangeError('Queue limits must be positive safe integers');
    this.#onAbort = () => this.cancel(signal.reason);
    signal.addEventListener('abort', this.#onAbort, { once: true });
    if (signal.aborted) this.cancel(signal.reason);
  }
  get pendingPackets(): number { return this.#values.length + this.#reservations.size; }
  reserve(): Promise<PacketReservation<T>> {
    if (this.#failure) return Promise.reject(this.#failure.reason);
    if (this.#closed) return Promise.reject(new Error('Queue closed'));
    if (this.pendingPackets < this.capacity) return Promise.resolve(this.#reservation());
    if (this.#waiters.length >= this.maxWaiters) return Promise.reject(new RangeError('Too many waiting producers'));
    return new Promise((resolve, reject) => { this.#waiters.push({ resolve, reject }); });
  }
  #reservation(): PacketReservation<T> {
    const token = {};
    this.#reservations.add(token);
    return {
      publish: (value) => {
        if (!this.#reservations.delete(token)) throw new Error('Reservation is no longer active');
        if (this.#closed) throw new Error('Queue closed');
        if (this.#reader) {
          const reader = this.#reader; this.#reader = undefined;
          reader.resolve({ value, done: false });
          this.#pump();
        } else this.#values.push(value);
      },
      release: () => { if (this.#reservations.delete(token)) this.#pump(); }
    };
  }
  #pump(): void {
    while (!this.#closed && this.#waiters.length && this.pendingPackets < this.capacity) this.#waiters.shift()!.resolve(this.#reservation());
  }
  /** Stops producers, revokes reservations, and lets the consumer drain published packets. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reservations.clear();
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error('Queue closed'));
    if (this.#reader) { this.#reader.resolve({ value: undefined, done: true }); this.#reader = undefined; }
    // Retain cancellation listener while published packets remain owned by the queue.
    if (!this.#values.length) this.signal.removeEventListener('abort', this.#onAbort);
  }
  /** Discards owned packets and rejects every pending operation. Idempotent. */
  cancel(reason: unknown = new Error('Queue cancelled')): void {
    if (this.#failure) return;
    this.#closed = true;
    const errors: unknown[] = [];
    for (const value of this.#values.splice(0)) { try { this.discard(value); } catch (error) { errors.push(error); } }
    this.#reservations.clear();
    const failure = errors.length ? new AggregateError([reason, ...errors], 'Queue cancellation cleanup failed') : reason;
    this.#failure = { reason: failure };
    for (const waiter of this.#waiters.splice(0)) waiter.reject(failure);
    if (this.#reader) { this.#reader.reject(failure); this.#reader = undefined; }
    this.signal.removeEventListener('abort', this.#onAbort);
  }
  next(): Promise<IteratorResult<T>> {
    if (this.#failure) return Promise.reject(this.#failure.reason);
    if (this.#reader) return Promise.reject(new Error('Concurrent queue reads are unsupported'));
    if (this.#values.length) {
      const value = this.#values.shift()!;
      this.#pump();
      if (this.#closed && !this.#values.length) this.signal.removeEventListener('abort', this.#onAbort);
      return Promise.resolve({ value, done: false });
    }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => { this.#reader = { resolve, reject }; });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: () => { this.cancel(new Error('Consumer stopped')); return Promise.resolve({ value: undefined, done: true }); }
    };
  }
}
