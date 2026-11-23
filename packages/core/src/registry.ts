import type { CapabilityStatus } from './index.js';
export interface FeatureDescriptor {
  readonly id: string;
  readonly status: CapabilityStatus;
  readonly testCases: readonly string[];
  /** Empty means no supported runtime, never an implicit wildcard. */
  readonly runtimes: readonly string[];
  readonly reason?: string;
}
export class FeatureResolutionError extends Error {
  constructor(readonly code: 'unknown-feature' | 'unimplemented' | 'runtime-blocked', readonly featureId: string, message: string) { super(message); }
}
/** Immutable metadata registry. Registration is not evidence of conformance or execution support. */
export class FeatureRegistry<T extends FeatureDescriptor> {
  #features = new Map<string, T>();
  register(feature: T): void {
    if (!/^[a-zA-Z0-9_.+-]+$/.test(feature.id)) throw new Error('Invalid feature ID');
    if (this.#features.has(feature.id)) throw new Error(`Duplicate feature: ${feature.id}`);
    if (!['unimplemented', 'partial', 'conformant', 'bitexact', 'runtime-blocked'].includes(feature.status)) throw new Error('Invalid capability status');
    if ((feature.status === 'conformant' || feature.status === 'bitexact') && !feature.testCases.length) throw new Error('Compatibility claims require test references');
    if (feature.status === 'runtime-blocked' && !feature.reason) throw new Error('Runtime-blocked feature requires a reason');
    if (feature.runtimes.some(runtime => !runtime) || new Set(feature.runtimes).size !== feature.runtimes.length || feature.testCases.some(test => !test)) throw new Error('Invalid runtime or test reference');
    // Plain metadata only: freezing a Map/Set would not freeze its entries.
    const seen = new Set<object>();
    function validate(value: unknown): void {
      if (value === null || ['string', 'number', 'boolean', 'undefined', 'bigint'].includes(typeof value)) return;
      if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Feature descriptors must contain plain metadata');
      if (seen.has(value)) throw new Error('Cyclic feature metadata');
      seen.add(value);
      for (const child of Object.values(value)) validate(child);
      seen.delete(value);
    }
    validate(feature);
    // Functions belong in a separate execution registry.
    const copy = structuredClone(feature);
    function freeze(value: unknown): void {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) freeze(child);
      }
    }
    freeze(copy);
    this.#features.set(copy.id, copy);
  }
  get(id: string): T | undefined { return this.#features.get(id); }
  list(): readonly T[] { return Object.freeze([...this.#features.values()].sort((a, b) => a.id.localeCompare(b.id))); }
  resolve(id: string, runtime: string): T {
    const feature = this.#features.get(id);
    if (!feature) throw new FeatureResolutionError('unknown-feature', id, `Unknown feature: ${id}`);
    if (feature.status === 'unimplemented') throw new FeatureResolutionError('unimplemented', id, `Unimplemented feature: ${id}`);
    if (feature.status === 'runtime-blocked' || !feature.runtimes.includes(runtime)) throw new FeatureResolutionError('runtime-blocked', id, feature.reason ?? `Feature ${id} is unavailable on ${runtime}`);
    return feature;
  }
}
