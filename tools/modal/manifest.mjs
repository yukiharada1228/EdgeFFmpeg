import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PORTABLE_TESTS = Object.freeze([
  'aformat', 'aiff', 'au', 'audio-convert', 'audio-filters', 'bounded-rational',
  'chroma', 'enable-timeline', 'encoder-sync-queue', 'expression',
  'filter-command-queue', 'foundation', 'frame-sync', 'framecrc', 'g711',
  'checkpoint', 'reframe-checkpoint', 'complex-command-graph', 'command-graph', 'distributed-planner', 'planner', 'durable-media-job', 'media-checkpoint-state', 'media-checkpoint-artifacts', 'media-job-spec', 'media-job-workflow-fence', 'media-workflow-plan', 'media-workflow-spec', 'media-workflow-control', 'media-workflow-graph', 'media-workflow-command-graph', 'media-workflow-complex-graph', 'memory-plan', 'number-rational', 'packet-queue', 'packet-schedule',
  'packet-sections', 'pad', 'pcm-representations', 'pcm',
  'pixel-color-metadata', 'pixel-color', 'pixel-convert', 'pixel-inverse',
  'pixel-resize-combined', 'pixel-resize-inverse', 'pixel-resize-rgb',
  'pixel-resize-yuv', 'pixel-resize', 'planar-filters', 'planar-g711',
  'planar-reframe', 'planar-remix', 'planar-resample', 'planar',
  'rate-boundary', 'raw-pcm', 'raw-video', 'reframe', 'remix', 'resample',
  'resource-reservations', 'resources', 'scale-expression', 'thread-frame-queue',
  'time', 'wav-mux', 'wav',
].map(name => `tests/unit/${name}.test.ts`).sort());

export const FLAC_TESTS = Object.freeze([
  'flac-base64-owned', 'flac-channel-mask', 'flac-chapters', 'flac-comments',
  'flac-configured-empty', 'flac-copy', 'flac-copy-duration', 'flac-demux-metadata-bounds', 'flac-demux',
  'flac-descriptor-validation', 'flac-max-filters', 'flac-max-remix', 'flac-max-remux',
  'flac-max-resample', 'flac-max-selection', 'flac-max-time', 'flac-max-trim',
  'flac-metadata', 'flac-output', 'flac-parser-flags', 'flac-parser', 'flac-pictures',
  'flac-aformat-constraints', 'flac-aformat-rate', 'flac-prepass', 'flac-ranges', 'flac-selection', 'flac-timed-aformat', 'flac-timed-buffered', 'flac-timed-filters', 'flac-timed-rate', 'flac-wave-encode',
].map(name => `tests/unit/${name}.test.ts`).sort());
export const FLAC_DEPENDENCIES = Object.freeze([
  'tests/helpers/flac-parser.ts',
  'compat/behavior-specs/flac-pictures/native-pictures.json',
  'compat/behavior-specs/flac-channel-mask/native-channel-masks.json',
  'compat/behavior-specs/flac-chapters/native-chapters.json',
  'compat/behavior-specs/flac-comments/native-comment-blocks.json',
  'compat/behavior-specs/flac-comments/native-comments.json',
  'compat/behavior-specs/flac-cli/cases.json',
  'compat/behavior-specs/flac-demux/metadata.json',
  'compat/behavior-specs/flac-demux/clean.json',
  'compat/behavior-specs/flac-demux-workers/large.json',
  'compat/behavior-specs/flac-max-remux/cases.json',
  'compat/behavior-specs/flac-max-selection/cases.json',
  'compat/behavior-specs/flac-selection/cases.json',
  'compat/behavior-specs/flac-parser/cases.json',
  'compat/behavior-specs/flac-parser/manifest.json',
  'compat/behavior-specs/flac-parser/provenance.json',
]);
function suiteFiles(suite) {
  if (suite === 'portable-unit-v1') return { tests: PORTABLE_TESTS, dependencies: ['tests/helpers/output.ts', 'tests/helpers/wav.ts'] };
  if (suite === 'flac-unit-v1') return { tests: FLAC_TESTS, dependencies: FLAC_DEPENDENCIES };
  throw new Error(`Unsupported validation suite: ${suite}`);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const rootFiles = new Set(['package.json', 'package-lock.json', 'tsconfig.json',
  'tsconfig.node.json', 'tsconfig.tests.json', 'tsconfig.workers.json', 'vitest.config.mjs',
  'compat/reference-container.lock.json']);
export function isAllowedPath(path, suite = 'portable-unit-v1') {
  const { tests, dependencies } = suiteFiles(suite);
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') ||
    /^(?:node_modules|dist|coverage|auth|credentials|secrets?|tokens?)$/i.test(part))) return false;
  if (/(?:^|[._-])(?:secret|token|credential|password|private[-_]?key)(?:[._-]|$)/i.test(parts.at(-1))) return false;
  if (rootFiles.has(path)) return true;
  return /^(?:packages\/|tools\/modal\/)/.test(path) && /\.(?:ts|js|mjs|json|py)$/.test(path) || tests.includes(path) || dependencies.includes(path);
}

export function planShards(paths, count = 16) {
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new RangeError('shards must be an integer from 1 to 32');
  const sorted = [...new Set(paths)].sort();
  if (count > sorted.length) throw new RangeError('shards cannot exceed test file count');
  const shards = Array.from({ length: count }, (_, id) => ({ id, testFiles: [] }));
  sorted.forEach((path, index) => shards[index % count].testFiles.push(path));
  return shards;
}

export function validateTestDependencies(root, files) {
  const selected = new Set(files.map(file => file.path));
  for (const { path } of files.filter(file => file.path.startsWith('tests/'))) {
    const source = readFileSync(resolve(root, path), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const dependency = relative(root, resolve(root, dirname(path), match[1])).split('\\').join('/');
      if (![dependency, dependency.replace(/\.js$/, '.ts')].some(candidate => selected.has(candidate))) {
        throw new Error(`Test dependency omitted from manifest: ${path} imports ${match[1]}`);
      }
    }
  }
}

export function createManifest(root, { shards = 16, suite = 'portable-unit-v1' } = {}) {
  const { tests, dependencies } = suiteFiles(suite);
  root = realpathSync(root);
  const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(path => isAllowedPath(path, suite)))].sort();
  const files = paths.map(path => {
    const absolute = resolve(root, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || realpathSync(absolute) !== absolute) throw new Error(`Nonregular or symlink source rejected: ${path}`);
    const data = readFileSync(absolute);
    return { path, sha256: sha256(data), bytes: data.byteLength };
  });
  for (const path of [...rootFiles, ...tests, ...dependencies]) {
    if (!files.some(file => file.path === path)) throw new Error(`Required source missing: ${path}`);
  }
  validateTestDependencies(root, files);
  return { schemaVersion: 1, suite,
    evidenceScope: suite === 'flac-unit-v1' ? 'Linux TypeScript FLAC unit tests consuming immutable recorded fixtures; no fresh Native FFmpeg, decoder Wasm, or Workers conformance claim' : 'Linux portable TypeScript unit tests; no Native FFmpeg, Darwin oracle, Wasm, or Workers conformance claim',
    source: { sha256: sha256(JSON.stringify(files)), files },
    shards: planShards(tests, shards) };
}

export function stageManifest(root, stage, manifest) {
  root = realpathSync(root);
  stage = resolve(stage);
  // Exclusive creation prevents following pre-existing links or mixing stale uploads.
  mkdirSync(stage, { recursive: false });
  for (const entry of manifest.source.files) {
    if (!isAllowedPath(entry.path, manifest.suite)) throw new Error(`Forbidden staged path: ${entry.path}`);
    const source = resolve(root, entry.path);
    if (!lstatSync(source).isFile() || realpathSync(source) !== source) throw new Error(`Nonregular source: ${entry.path}`);
    const data = readFileSync(source);
    if (data.length !== entry.bytes || sha256(data) !== entry.sha256) throw new Error(`Source changed during staging: ${entry.path}`);
    const target = resolve(stage, entry.path);
    if (relative(stage, target).startsWith('..')) throw new Error('Staging traversal');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: 'wx' });
  }
  writeFileSync(resolve(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!['--root', '--shards', '--output', '--stage', '--suite'].includes(name) || !value || options[name] !== undefined) throw new Error('Usage: manifest.mjs [--root DIR] [--shards 1..32] [--output FILE] [--stage NEW_DIR] [--suite portable-unit-v1|flac-unit-v1]');
    options[name] = value;
  }
  const root = resolve(options['--root'] ?? process.cwd());
  const manifest = createManifest(root, { shards: Number(options['--shards'] ?? 16), suite: options['--suite'] ?? 'portable-unit-v1' });
  if (options['--stage']) stageManifest(root, options['--stage'], manifest);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options['--output']) writeFileSync(resolve(options['--output']), json);
  else process.stdout.write(json);
}
