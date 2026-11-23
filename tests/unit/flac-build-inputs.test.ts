import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const base = new URL('../../tools/codecs/flac/', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('inputs.json', base), 'utf8')) as {
  files: Record<string, string>; wasmSha256: string; wasmBytes: number;
};

describe('pinned FLAC build inputs', () => {
  it('retains exact reviewed wrapper, recipe, verifier, ABI and notices', () => {
    for (const [path, sha] of Object.entries(pins.files)) {
      expect(createHash('sha256').update(readFileSync(new URL(path, base))).digest('hex'), path).toBe(sha);
    }
    expect(pins.wasmBytes).toBe(69607);
    expect(pins.wasmSha256).toBe('d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f');
  });

  it('rejects an invalid module before it can be used as a decoder', () => {
    const script = `import {inspectPrototypeWasm} from ${JSON.stringify(new URL('validate-wasm.mjs', base).href)};
      for (const bytes of [Buffer.alloc(0), Buffer.from([0,97,115,109,1,0,0,0])]) {
        let rejected=false; try { inspectPrototypeWasm(bytes); } catch { rejected=true; }
        if (!rejected) process.exit(1);
      }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('inspects the canonical or supplied fresh artifact and exact bytes', () => {
    const artifact = process.env['FLAC_BUILD_ARTIFACT'] ?? fileURLToPath(new URL('../../.build/codecs/flac/edge-flac.wasm', import.meta.url));
    const bytes = readFileSync(artifact);
    expect(bytes.length).toBe(pins.wasmBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pins.wasmSha256);
    const script = `import {inspectPrototypeWasm} from ${JSON.stringify(new URL('validate-wasm.mjs', base).href)};
      import {readFileSync} from 'node:fs';
      const {evidence} = inspectPrototypeWasm(readFileSync(process.argv[1]));
      if(evidence.abi!==1 || evidence.infoWords!==29 || evidence.memory.bytes!==16777216) process.exit(1);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, artifact], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('requires explicit local paths and never implicitly builds the prototype', () => {
    const result = spawnSync('python3', [fileURLToPath(new URL('build.py', base))], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--source');
    expect(result.stderr).toContain('--archive');
    expect(result.stderr).toContain('--emsdk');
    expect(result.stderr).toContain('--out');
  });
});
