import { ResourceContext } from '@edge-ffmpeg/core';
import type { ResourceBudget, VirtualFileSystem } from '@edge-ffmpeg/core';
export interface CloudflareRuntimeOptions {
  filesystem: VirtualFileSystem;
  budget: ResourceBudget;
  signal: AbortSignal;
}
/** Per-execution state. No global request state and no media semantics. */
export function createCloudflareRuntime(options: CloudflareRuntimeOptions) {
  const resources = new ResourceContext(options.budget, options.signal);
  return {
    filesystem: options.filesystem,
    resources,
    signal: options.signal,
    checkpoint(): Promise<void> {
      options.signal.throwIfAborted();
      // Cancellation boundary only; state persistence and CPU observation are not yet implemented.
      return Promise.resolve();
    }
  };
}
