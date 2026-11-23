import { it, expect } from 'vitest';
import { importsOf, checkImport, findCycles } from '../../tools/package-boundaries/check.mjs';
it('finds static, type and dynamic imports without matching comments', () => {
  expect(importsOf(`// import x from 'ignored';
import type { A } from 'a'; export { x } from 'b';
type X = import('c').X; const p = import('d'); const q = import(name);`)).toEqual(['a', 'b', 'c', 'd', '<dynamic-module>']);
});
it('rejects runtime leakage, undeclared dependencies and relative escapes', () => {
  const check = spec => checkImport('@edge-ffmpeg/core', spec, new Set(['@edge-ffmpeg/avutil']), new Set(['@edge-ffmpeg/avutil']), '/repo/packages/core/src/index.ts', '/repo/packages/core');
  expect(check('node:fs')).toMatch(/Runtime/);
  expect(check('@cloudflare/workers-types')).toMatch(/Runtime/);
  expect(check('unlisted')).toMatch(/Undeclared/);
  expect(check('../../avutil/src/index.js')).toMatch(/escapes/);
  expect(check('@edge-ffmpeg/avutil/private')).toMatch(/public/);
  expect(check('@edge-ffmpeg/avutil')).toBeNull();
  expect(check('./resources.js')).toBeNull();
});
it('detects indirect dependency cycles', () => {
  expect(findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual(['a -> b -> c -> a']);
  expect(findCycles(new Map([['a', ['b']], ['b', []]]))).toEqual([]);
});

it('permits the Workers builtin only within the Cloudflare runtime adapter', () => {
  const check = (owner, specifier) => checkImport(owner, specifier, new Set(), new Set(), '/repo/packages/runtime-cloudflare/src/jobs.ts', '/repo/packages/runtime-cloudflare');
  expect(check('@edge-ffmpeg/runtime-cloudflare', 'cloudflare:workers')).toBeNull();
  expect(check('@edge-ffmpeg/core', 'cloudflare:workers')).toMatch(/Runtime/);
  expect(check('@edge-ffmpeg/runtime-node', 'cloudflare:workers')).toMatch(/Cloudflare/);
  expect(check('@edge-ffmpeg/runtime-cloudflare', 'cloudflare:unknown')).toMatch(/Cloudflare/);
});
