import type { WriteHandle } from '@edge-ffmpeg/core';
/** Small-fixture test sink only; production output must not collect a whole file in memory. */
export function collectingOutput() {
  const chunks: Uint8Array[] = [];
  let committed = false, aborted = false;
  const output: WriteHandle = {
    async write(chunk) { if (committed || aborted) throw new Error('Output closed'); chunks.push(chunk.slice()); },
    async commit() { if (aborted) throw new Error('Output aborted'); committed = true; },
    async abort() { aborted = true; chunks.length = 0; }
  };
  return { output, get committed() { return committed; }, get aborted() { return aborted; },
    get lengths() { return chunks.map(chunk => chunk.length); },
    bytes() { const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
  };
}
