import { parseListing } from './parse.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../..');
const binary = resolve(root, '.build/reference/ffmpeg');
const metadata = JSON.parse(readFileSync(resolve(root, '.build/reference/build-metadata.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'compat/upstream.lock.json'), 'utf8'));
const source = resolve(root, 'upstream/ffmpeg');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (commit !== lock.commit || metadata.commit !== commit) throw new Error('Reference source/build commit mismatch');
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' }).trim()) throw new Error('Modified reference source');
const flags = readFileSync(resolve(root, lock.configureFile), 'utf8').trim().split(/\s+/);
if (JSON.stringify(flags) !== JSON.stringify(metadata.flags)) throw new Error('Reference configure flags changed; rebuild required');
for (const name of ['ffmpeg', 'ffprobe']) {
  const actual = createHash('sha256').update(readFileSync(resolve(root, '.build/reference', name))).digest('hex');
  if (metadata.artifacts?.[name] !== actual) throw new Error(`Reference artifact hash mismatch: ${name}; rebuild required`);
}
const capabilities = [];
const raw = {};
for (const [kind, flag] of Object.entries({ encoder: 'encoders', decoder: 'decoders', filter: 'filters', format: 'formats', codec: 'codecs', protocol: 'protocols', pixelFormat: 'pix_fmts', sampleFormat: 'sample_fmts', hardware: 'hwaccels' })) {
  const output = execFileSync(binary, ['-hide_banner', `-${flag}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  raw[flag] = output;
  const parsed = parseListing(kind, output);
  if (parsed.length === 0 && kind !== 'hardware') throw new Error(`Empty listing: ${flag}`);
  for (const entry of parsed) {
    const actualKind = entry.kind ?? kind;
    const id = `${actualKind}.${entry.direction ? entry.direction + '.' : ''}${entry.name}`;
    capabilities.push({ id, kind: actualKind, upstream: '9.0.2', implementation: 'unimplemented', runtime: 'cloudflare', testCases: [], compatibility: { functional: false, bitexact: false }, reference: entry });
  }
}
const unique = [...new Map(capabilities.map(x => [x.id, x])).values()].sort((a,b) => a.id.localeCompare(b.id));
if (unique.length === 0) throw new Error('No capabilities extracted');
// Progress annotations never certify full functional or bit-exact conformance.
const progress = JSON.parse(readFileSync(resolve(root, 'compat/implementation-progress.json'), 'utf8'));
for (const [id, annotation] of Object.entries(progress)) {
  const feature = unique.find(feature => feature.id === id);
  if (!feature) throw new Error(`Progress refers to a capability absent from the reference: ${id}`);
  if (!['partial', 'unimplemented', 'runtime-blocked'].includes(annotation.implementation)) throw new Error(`Conformance certification requires a verified report: ${id}`);
  if (!Array.isArray(annotation.testCases) || (annotation.implementation === 'partial' && annotation.testCases.length === 0)) throw new Error(`Missing progress test references: ${id}`);
  for (const test of annotation.testCases) {
    if (typeof test !== 'string' || !test.startsWith('tests/') || test.split('/').includes('..') || !existsSync(resolve(root, test))) throw new Error(`Invalid progress test reference: ${test}`);
  }
  Object.assign(feature, { implementation: annotation.implementation, testCases: annotation.testCases, notes: annotation.notes });
}
mkdirSync(resolve(root, 'compat/reports'), { recursive: true });
writeFileSync(resolve(root, 'compat/reports/reference-listings.json'), JSON.stringify(raw, null, 2) + '\n');
writeFileSync(resolve(root, 'compat/capabilities.json'), JSON.stringify({ reference: metadata, binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), capabilities: unique }, null, 2) + '\n');
console.log(`Extracted ${unique.length} capabilities (${unique.filter(feature => feature.implementation === 'partial').length} partial; no conformance certified)`);
