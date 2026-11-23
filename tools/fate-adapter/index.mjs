import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryFate } from './parse.mjs';
const root = resolve(import.meta.dirname, '../..');
const upstream = resolve(root, 'upstream/ffmpeg');
const lock = JSON.parse(readFileSync(resolve(root, 'compat/upstream.lock.json'), 'utf8'));
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim() !== lock.commit) throw new Error('Upstream commit mismatch');
const cases = [];
const files = [];
for (const file of readdirSync(resolve(upstream, 'tests/fate')).filter(x => x.endsWith('.mak')).sort()) {
  const relative = `tests/fate/${file}`;
  const source = readFileSync(resolve(upstream, relative), 'utf8');
  files.push({ file: relative, sha256: createHash('sha256').update(source).digest('hex') });
  for (const entry of inventoryFate(source, relative)) cases.push({ ...entry, referenceFile: existsSync(resolve(upstream, 'tests/ref/fate', entry.id.slice(5))) ? `tests/ref/fate/${entry.id.slice(5)}` : null });
}
mkdirSync(resolve(root, 'compat/reports'), { recursive: true });
writeFileSync(resolve(root, 'compat/reports/fate-inventory.json'), JSON.stringify({ commit: lock.commit, files, cases, limitation: 'Explicit CMD definitions only. Conditional make evaluation and generated target expansion are not implemented. This is not a total FATE case count.' }, null, 2) + '\n');
console.log(`Inventoried ${cases.length} explicit FATE command definitions; none claimed as ported`);
