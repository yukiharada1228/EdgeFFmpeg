import type { ResourceBudget } from './index.js';
export interface OwnedBuffer {
  readonly data: Uint8Array;
  release(): void;
}
/** Release callback for externally owned resident memory. */
export type ExternalMemoryRelease = () => void;
/** Accounts owned buffers and explicitly reserved external memory; excludes runtime overhead. */
export class ResourceContext {
  #resident = 0;
  readonly budget: Readonly<ResourceBudget>;
  constructor(budget: ResourceBudget, readonly signal: AbortSignal) {
    for (const value of Object.values(budget)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Budgets must be positive safe integers');
    }
    if (budget.maxBufferBytes > budget.maxResidentBytes) throw new RangeError('Buffer limit exceeds resident limit');
    this.budget = Object.freeze({ ...budget });
  }
  get allocatedBytes(): number { return this.#resident; }
  /** Reserve resident memory without allocating a placeholder buffer.
   * External allocations are independent of the single-buffer limit. */
  reserveExternalMemory(bytes: number): ExternalMemoryRelease {
    this.signal.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid reservation size');
    if (bytes > this.budget.maxResidentBytes - this.#resident) throw new RangeError('Memory budget exceeded');
    this.#resident += bytes;
    let released = false;
    return () => { if (!released) { released = true; this.#resident -= bytes; } };
  }
  allocate(bytes: number): OwnedBuffer {
    this.signal.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid allocation size');
    if (bytes > this.budget.maxBufferBytes || bytes > this.budget.maxResidentBytes - this.#resident)
      throw new RangeError('Memory budget exceeded');
    const data = new Uint8Array(bytes);
    this.#resident += bytes;
    let released = false;
    return { data, release: () => {
      if (!released) { this.#resident -= bytes; released = true; }
    } };
  }
}
