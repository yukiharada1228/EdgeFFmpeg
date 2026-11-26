import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { planShards, validatePlan, shardMatrix, laneFor, suiteFiles, SUITES, fastPlan } from '../../tools/ci/plan.mjs';
import { readShardDirectory, collectSuite, checkShardSet, restoreOutputs, shardCommand } from '../../tools/compatibility-report/shards.mjs';
import { summarizeSuite } from '../../tools/compatibility-report/summarize.mjs';
import { globMatcher, affectedTests, branchPoint } from '../../tools/ci/affected.mjs';
import { treeManifest, verifyTree, recordedHash } from '../../tools/ci/reference-tree.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const SOURCE = sha('source'), EDITED = sha('edited');
const files = ['tests/unit/a.test.ts', 'tests/unit/b.test.js', 'tests/unit/c.test.ts', 'tests/unit/d.test.ts', 'tests/unit/helper.ts', 'tests/integration/e.test.ts', 'tests/differential/f.test.ts', 'tests/workers/g.test.ts', 'packages/x/src/x.ts'];
const durations = { profiles: { 'linux-x64': { files: { 'tests/unit/a.test.ts': 30, 'tests/unit/b.test.js': 10, 'tests/unit/c.test.ts': 20 } } } };
const counts = { unit: 2, integration: 1, differential: 1, workers: 1 };
const plan = () => planShards(files, { counts, durations, profile: 'linux-x64' });

it('assigns every test file to exactly one non-empty shard, balanced by measured duration', () => {
  const result = validatePlan(plan());
  // Longest first, each to the least-loaded shard: a (30), c (20), d (unmeasured: the suite mean, 20), then b (10).
  expect(result.suites.unit).toEqual([['tests/unit/a.test.ts', 'tests/unit/b.test.js'], ['tests/unit/c.test.ts', 'tests/unit/d.test.ts']]);
  expect(result.estimatedSeconds.unit).toEqual([40, 40]);
  expect(result.unmeasured).toEqual(['tests/unit/d.test.ts', 'tests/integration/e.test.ts', 'tests/differential/f.test.ts', 'tests/workers/g.test.ts']);
  for (const suite of SUITES) expect(result.suites[suite].flat().sort()).toEqual(suiteFiles(files, suite));
  expect(plan().sha256).toBe(result.sha256);
  expect(planShards(files, { counts: { ...counts, unit: 9 }, durations, profile: 'linux-x64' }).suites.unit).toHaveLength(4);
  const zero = planShards(['tests/unit/a.test.ts', 'tests/unit/b.test.ts'], { counts, durations: { profiles: { 'linux-x64': { files: { 'tests/unit/a.test.ts': 0, 'tests/unit/b.test.ts': 0 } } } }, profile: 'linux-x64' });
  expect(zero.suites.unit.map(shard => shard.length)).toEqual([1, 1]);
  expect(shardMatrix(result).map(entry => entry.id)).toEqual(['unit-1', 'unit-2', 'differential-1', 'integration-1', 'workers-1']);
});
it('rejects plans with an empty shard, a file in two shards, an altered list or a foreign file', () => {
  const base = plan(), rehash = value => ({ ...value, sha256: sha(JSON.stringify({ mode: value.mode, suites: value.suites })) });
  expect(() => validatePlan({ ...base, suites: { ...base.suites, unit: [...base.suites.unit, []] } })).toThrow();
  expect(() => validatePlan(rehash({ ...base, suites: { ...base.suites, unit: [...base.suites.unit, []] } }))).toThrow('empty');
  expect(() => validatePlan(rehash({ ...base, suites: { ...base.suites, unit: [['tests/unit/a.test.ts'], ['tests/unit/a.test.ts', 'tests/unit/b.test.js']] } }))).toThrow('two shards');
  expect(() => validatePlan(rehash({ ...base, suites: { ...base.suites, unit: [['tests/integration/e.test.ts']] } }))).toThrow('outside');
});
it('runs the fast lane only for pushes to wave2 branches that are not integration branches', () => {
  expect(laneFor({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/wave2/af-example' })).toBe('fast');
  for (const [event, ref] of [['push', 'refs/heads/wave2/integration'], ['push', 'refs/heads/wave2/integration-2'], ['push', 'refs/heads/feat/initial-implementation'], ['push', 'refs/heads/linux-green/integration'], ['push', 'refs/heads/ci-fast/pipeline'], ['push', 'refs/tags/v1'], ['pull_request', 'refs/heads/wave2/af-example']])
    expect(laneFor({ GITHUB_EVENT_NAME: event, GITHUB_REF: ref }), ref).toBe('full');
  const hub = globMatcher(['packages/*/src/index.ts', 'packages/**/registry.ts', 'tsconfig*.json', 'tools/ci/**']);
  expect(['packages/avfilter/src/index.ts', 'packages/avfilter/src/audio/registry.ts', 'packages/core/src/registry.ts', 'tsconfig.tests.json', 'tools/ci/plan.mjs'].every(hub)).toBe(true);
  expect(['packages/avfilter/src/audio/index.ts', 'packages/avfilter/src/audio/registry.test.ts', 'tools/cix/a.mjs', 'xtsconfig.json'].some(hub)).toBe(false);
});

// A shard directory as tools/ci/shard.mjs writes it, for a two-file unit suite split into two shards.
function fixture(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'edgeffmpeg-shards-')), directory = join(root, 'shards'), evidence = join(root, 'evidence');
  mkdirSync(directory); mkdirSync(evidence);
  const unitFiles = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'];
  const shardPlan = planShards(unitFiles, { counts, durations: { profiles: {} }, profile: 'linux-x64' });
  const context = { root, directory, evidence, plan: shardPlan, expected: unitFiles, policy: undefined, before: { sha256: SOURCE, revision: 'commit' }, referenceBefore: { ffmpeg: 'native' }, platform: { host: `${process.platform}-${process.arch}` }, outputs: new Map() };
  const shards = shardPlan.suites.unit.map((list, position) => {
    const id = `unit-${position + 1}`;
    const raw = { success: true, numTotalTests: list.length, numPassedTests: list.length, numFailedTests: 0, testResults: list.map(file => ({ name: `${root}/${file}`, status: 'passed', assertionResults: [{ fullName: `case ${file}`, status: 'passed' }] })) };
    const meta = { schemaVersion: 1, kind: 'edgeffmpeg-test-shard', id, suite: 'unit', index: position + 1, count: shardPlan.suites.unit.length, planMode: 'full', planSha256: shardPlan.sha256, files: list, command: shardCommand('unit', list, id), exitCode: 0, signal: null, startedAt: '2026-11-26T00:00:00.000Z', finishedAt: '2026-11-26T00:00:01.000Z', durationMs: 5, log: `${id}.log`, report: `${id}.json`, root, revision: 'commit', sourceBefore: SOURCE, sourceAfter: SOURCE, referenceBefore: { ffmpeg: 'native' }, referenceAfter: { ffmpeg: 'native' }, platform: { host: context.platform.host }, environment: { node: process.version, platform: process.platform, arch: process.arch }, preparation: null, outputs: [], ci: null };
    return { id, raw, meta, log: `log ${id}\n`, files: {} };
  });
  mutate({ shards, context });
  for (const shard of shards) {
    const report = JSON.stringify(shard.raw);
    writeFileSync(join(directory, `${shard.id}.json`), report); writeFileSync(join(directory, `${shard.id}.log`), shard.log);
    // Extra files of the shard (a preparation log, test outputs), by path relative to the shard directory.
    for (const [path, text] of Object.entries(shard.files)) { mkdirSync(join(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), text); }
    writeFileSync(join(directory, `${shard.id}.shard.json`), JSON.stringify({ logSha256: sha(shard.log), reportSha256: sha(report), ...shard.meta }));
  }
  return { root, context, collect: () => collectSuite('unit', readShardDirectory(directory), context) };
}
function check(mutate, assert) { const { root, context, collect } = fixture(mutate); try { assert(collect(), context); } finally { rmSync(root, { recursive: true, force: true }); } }

it('merges complete shards into the same suite evidence as one Vitest run of every file', () => {
  check(() => {}, (result, context) => {
    expect(result.gate).toMatchObject({ name: 'tests-unit', status: 'passed', exitCode: 0 });
    expect(result.gate.shards.map(shard => shard.id)).toEqual(['unit-1', 'unit-2']);
    expect(result.sourceStable && result.referenceStable).toBe(true);
    const serial = summarizeSuite(JSON.parse(readFileSync(join(context.evidence, 'unit.json'), 'utf8')), context.expected, context.root);
    expect(result.suite).toMatchObject({ status: 'passed', total: 2, passed: 2, missingFiles: [] });
    expect(result.suite.assertions).toEqual(serial.assertions);
  });
});
it('rejects a missing, empty, partial, duplicated, unexpected or altered shard instead of skipping it', () => {
  const invalid = (mutate, reason) => check(mutate, result => { expect(result.suite.status, reason).toBe('invalid-evidence'); expect(result.suite.reason).toContain(reason); });
  invalid(({ shards }) => { shards.pop(); }, 'missing shard unit-2');
  invalid(({ shards }) => { Object.assign(shards[1].raw, { numTotalTests: 0, numPassedTests: 0, testResults: [] }); }, 'shard unit-2');
  invalid(({ shards }) => { shards[1].raw.testResults = []; Object.assign(shards[1].raw, { numTotalTests: 0, numPassedTests: 0 }); }, 'empty');
  invalid(({ shards }) => { shards[1].meta.files = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts']; }, 'file list differs');
  invalid(({ shards }) => { shards.push({ ...shards[1], id: 'unit-3', meta: { ...shards[1].meta, id: 'unit-3', index: 3 } }); }, 'unexpected shard unit-3');
  invalid(({ shards }) => { shards[0].meta.planSha256 = 'other'; }, 'ran plan');
  invalid(({ shards }) => { shards[0].meta.environment = { ...shards[0].meta.environment, node: 'v0.0.0' }; }, 'Node v0.0.0');
  invalid(({ shards }) => { shards[0].meta.report = null; }, 'no Vitest JSON');
  invalid(({ shards }) => { shards[0].raw.testResults[0].assertionResults.push({ fullName: 'extra', status: 'passed' }); }, 'count mismatch');
  invalid(({ context }) => { context.expected = [...context.expected, 'tests/unit/c.test.ts']; }, 'does not assign every');
  const { root, collect } = fixture();
  try { writeFileSync(join(root, 'shards', 'unit-1.json'), '{}'); expect(collect().suite.reason).toContain('does not match its recorded sha256'); } finally { rmSync(root, { recursive: true, force: true }); }
  check(({ shards }) => { shards[0].raw.testResults[0].assertionResults[0].status = 'failed'; shards[0].raw.numPassedTests = 0; shards[0].raw.numFailedTests = 1; shards[0].raw.success = false; shards[0].meta.exitCode = 1; },
    result => { expect(result.gate.status).toBe('failed'); expect(result.suite.status).toBe('failed'); expect(result.suite.failed).toBe(1); });
  check(({ shards }) => { shards[1].meta.sourceAfter = EDITED; }, result => { expect(result.sourceStable).toBe(false); expect(result.referenceStable).toBe(true); });
  check(({ shards }) => { shards[1].meta.referenceBefore = { ffmpeg: 'other' }; }, result => expect(result.referenceStable).toBe(false));
  const { root: other } = fixture();
  try { expect(() => { writeFileSync(join(other, 'shards', 'unit-9x.shard.json'), '{}'); readShardDirectory(join(other, 'shards')); }).toThrow('Unexpected shard record'); } finally { rmSync(other, { recursive: true, force: true }); }
});
it('rejects a failed --prepare step, a command or record that is not the shard runner\'s, and inconsistent records', () => {
  const invalid = (mutate, reason) => check(mutate, result => { expect(result.suite.status, reason).toBe('invalid-evidence'); expect(result.suite.reason).toContain(reason); });
  const prepared = (shard, status, exitCode) => { shard.meta.preparation = { command: ['npm', 'run', 'reference:extract'], status, exitCode, durationMs: 1, log: `${shard.id}.prepare.log`, logSha256: sha('prepare\n') }; shard.files[`${shard.id}.prepare.log`] = 'prepare\n'; };
  // Vitest exited 0, but reference:extract failed before it: the shard did not test the intended tree.
  check(({ shards }) => { for (const shard of shards) prepared(shard, 'passed', 0); prepared(shards[1], 'failed', 1); },
    result => { expect(result.gate.status).toBe('failed'); expect(result.suite.status).toBe('invalid-evidence'); expect(result.suite.reason).toContain('--prepare step (npm run reference:extract) failed'); });
  check(({ shards }) => { for (const shard of shards) prepared(shard, 'passed', 0); }, result => { expect(result.gate.status).toBe('passed'); expect(result.suite.status).toBe('passed'); });
  invalid(({ shards }) => { prepared(shards[0], 'passed', 0); delete shards[0].files['unit-1.prepare.log']; }, 'preparation log is missing');
  invalid(({ shards }) => { shards[0].meta.command = [...shards[0].meta.command.slice(0, -1), '-t', 'only this', shards[0].meta.command.at(-1)]; }, 'command is not the unit suite');
  invalid(({ shards }) => { shards[0].meta.log = 'other.log'; shards[0].files['other.log'] = shards[0].log; }, 'log is not recorded as <id>.log');
  invalid(({ shards }) => { shards[0].meta.finishedAt = '2026-11-25T00:00:00.000Z'; }, 'records the times');
  invalid(({ shards }) => { shards[0].meta.durationMs = 60000; }, 'does not fit');
  invalid(({ shards }) => { shards[0].meta.exitCode = null; }, 'records exit null');
  invalid(({ shards }) => { delete shards[0].meta.outputs; }, 'no list of test outputs');
  invalid(({ shards }) => { shards[0].meta.revision = 'other'; }, 'ran on revision other');
  // Checks across all records of a run.
  const records = (mutate = () => {}) => { const list = [0, 1].map(index => ({ id: `unit-${index + 1}`, revision: 'commit', ci: { runId: '1', runAttempt: '1', sha: 'commit' }, preparation: { status: 'passed' } })); mutate(list); return new Map(list.map(meta => [meta.id, meta])); };
  expect(checkShardSet(records(), { revision: 'commit' })).toEqual([]);
  expect(checkShardSet(records(list => { list[1].ci = { ...list[1].ci, runId: '2' }; }), { revision: 'commit' }).join()).toContain('2 different CI runs');
  expect(checkShardSet(records(list => { list[1].ci = { ...list[1].ci, runAttempt: '2' }; }), { revision: 'commit' })).toEqual([]);
  expect(checkShardSet(records(list => { list[1].ci = null; }), { revision: 'commit' }).join()).toContain('mix CI and local runs');
  expect(checkShardSet(records(list => { list[1].preparation = null; }), { revision: 'commit' }).join()).toContain('some shards ran --prepare');
  expect(checkShardSet(records(list => { list[0].revision = 'old'; list[0].ci.sha = 'old'; }), { revision: 'commit' }).join()).toContain('revisions old, commit');
  expect(checkShardSet(records(list => { list[0].ci.sha = 'other'; }), { revision: 'commit' }).join()).toContain('records CI commit other');
});
it('keeps the files tests write under compat/reports and restores them, rejecting altered, foreign or conflicting outputs', () => {
  const output = (shard, path, text) => { shard.meta.outputs.push({ path, size: Buffer.byteLength(text), sha256: sha(text) }); shard.files[`${shard.id}.outputs/${path}`] = text; };
  const { root, context, collect } = fixture(({ shards }) => { output(shards[1], 'compat/reports/inverse-instability.json', '{"observations":1}\n'); });
  try {
    const result = collect();
    expect(result.suite.status).toBe('passed');
    expect(result.gate.shards[1].outputs).toEqual([{ path: 'compat/reports/inverse-instability.json', size: 19, sha256: sha('{"observations":1}\n') }]);
    expect(existsSync(join(context.evidence, 'shards', 'unit-2.outputs', 'compat/reports/inverse-instability.json'))).toBe(true);
    expect(restoreOutputs(context.outputs, { root })).toEqual([{ path: 'compat/reports/inverse-instability.json', shard: 'unit-2', sha256: sha('{"observations":1}\n'), size: 19 }]);
    expect(readFileSync(join(root, 'compat/reports/inverse-instability.json'), 'utf8')).toBe('{"observations":1}\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
  const invalid = (mutate, reason) => check(mutate, result => { expect(result.suite.status, reason).toBe('invalid-evidence'); expect(result.suite.reason).toContain(reason); });
  invalid(({ shards }) => { output(shards[0], 'compat/reports/x.json', 'a'); shards[0].files['unit-1.outputs/compat/reports/x.json'] = 'b'; }, 'does not match its recorded sha256');
  invalid(({ shards }) => { output(shards[0], 'compat/reports/x.json', 'a'); delete shards[0].files['unit-1.outputs/compat/reports/x.json']; }, 'test output compat/reports/x.json is missing');
  invalid(({ shards }) => { output(shards[0], 'packages/x.ts', 'a'); }, 'invalid test output "packages/x.ts"');
  invalid(({ shards }) => { output(shards[0], 'compat/reports/../../x', 'a'); }, 'invalid test output');
  invalid(({ shards }) => { output(shards[0], 'compat/reports/x.json', 'a'); output(shards[1], 'compat/reports/x.json', 'b'); }, 'differs from the one shard unit-1 wrote');
  check(({ shards }) => { output(shards[0], 'compat/reports/x.json', 'a'); output(shards[1], 'compat/reports/x.json', 'a'); }, result => expect(result.suite.status).toBe('passed'));
});
it('verifies every file of the reference tree, through its source link, against a recorded manifest hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'edgeffmpeg-tree-'));
  try {
    const write = (file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
    write('upstream/ffmpeg/tests/ref/fate/a', 'ref\n'); write('.build/reference/ffbuild/config.mak', 'SRC_PATH=./src\n'); write('.build/reference/ffmpeg', 'binary');
    write('.build/codecs/openh264/openh264.wasm', 'h264'); write('.build/codecs/flac/edge-flac.wasm', 'flac');
    symlinkSync(join(root, 'upstream/ffmpeg'), join(root, '.build/reference/src'));
    const recorded = treeManifest(root);
    expect(recorded.entries.map(entry => entry[0])).toEqual(['.build/codecs/flac/edge-flac.wasm', '.build/codecs/openh264/openh264.wasm', '.build/reference/ffbuild/config.mak', '.build/reference/ffmpeg', '.build/reference/src/tests/ref/fate/a']);
    const manifest = join(root, '.build/reference-tree.json'); writeFileSync(manifest, JSON.stringify(recorded));
    expect(verifyTree(recorded.sha256, { directory: root, manifest }).ok).toBe(true);
    // An artifact replaces the link with a copy of what it points to: the same manifest.
    rmSync(join(root, '.build/reference/src')); write('.build/reference/src/tests/ref/fate/a', 'ref\n');
    expect(verifyTree(recorded.sha256, { directory: root, manifest }).ok).toBe(true);
    write('.build/reference/ffbuild/config.mak', 'SRC_PATH=/elsewhere\n'); write('.build/reference/tests/extra', 'x'); rmSync(join(root, '.build/reference/src/tests/ref/fate/a'));
    const result = verifyTree(recorded.sha256, { directory: root, manifest });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining(['changed .build/reference/ffbuild/config.mak', 'added .build/reference/tests/extra', 'missing .build/reference/src/tests/ref/fate/a']));
    expect(recordedHash('reference-v2-k', `reference-v2-k-tree-${recorded.sha256}`)).toBe(recorded.sha256);
    expect(() => recordedHash('reference-v2-k', 'reference-v2-k')).toThrow('is not reference-v2-k-tree-<sha256>');
    expect(() => recordedHash('reference-v2-k', 'reference-v2-other-tree-' + recorded.sha256)).toThrow();
    expect(() => verifyTree('', { directory: root })).toThrow('Invalid recorded tree hash');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('selects every test that reaches a change: through hubs and barrels, relative and literal paths, directories, scripts and deletions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edgeffmpeg-affected-'));
  try {
    const write = (file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
    const sources = {
      'package.json': JSON.stringify({ scripts: { 'reference:x': 'node tools/x/generate.mjs' } }),
      'packages/x/src/leaf.ts': 'export const leaf = 1;\n',
      'packages/x/src/other.ts': 'export const other = 2;\n',
      'packages/x/src/registry.ts': "export {leaf} from './leaf.js';\nexport {other} from './other.js';\n",
      'packages/x/src/index.ts': "export * from './registry.js';\n",
      'tests/helpers/use.ts': "export {leaf} from '../../packages/x/src/leaf.js';\n",
      'tests/unit/direct.test.ts': "import {leaf} from '../helpers/use.js';\nconsole.log(leaf);\n",
      'tests/unit/through-hub.test.ts': "import {other} from '../../packages/x/src/index.js';\nconsole.log(other);\n",
      'tests/unit/type-only.test.ts': "import type {Leaf} from '../../packages/x/src/types.js';\nconst value: Leaf = 1;\nconsole.log(value);\n",
      'packages/x/package.json': JSON.stringify({ name: '@edge-ffmpeg/x', exports: './src/index.ts' }),
      'tests/unit/workspace-type.test.ts': "import type {Other} from '@edge-ffmpeg/x';\nconst value: Other = 1;\nconsole.log(value);\n",
      'packages/x/src/types.ts': 'export type Leaf = number;\n',
      'tests/unit/x-registry.test.ts': "console.log('registry');\n",
      'tests/unit/corpus.test.ts': "const path = 'compat/behavior-specs/x/cases.json';\nconsole.log(path);\n",
      'tests/unit/relative.test.ts': "import {readFileSync} from 'node:fs';\nconsole.log(readFileSync(new URL('../fixtures/sample.json', import.meta.url)));\n",
      'tests/unit/joined.test.ts': "import {join} from 'node:path';\nconsole.log(join(import.meta.dirname, '..', 'fixtures', 'dir'));\n",
      'tests/unit/template.test.ts': "const name = 'a';\nconsole.log(`${process.cwd()}/compat/behavior-specs/${name}.json`);\n",
      'tests/unit/script.test.ts': "import {execFileSync} from 'node:child_process';\nexecFileSync('npm', ['run', 'reference:x']);\n",
      'tests/unit/spawn.test.ts': "import {execFileSync} from 'node:child_process';\nexecFileSync(process.execPath, ['tools/cli/run.mjs']);\n",
      'tests/unit/workers-fixture.test.ts': "const fixture = 'tests/workers/x-fixture.ts';\nconsole.log(fixture);\n",
      'tests/workers/x-fixture.ts': "import wasm from './missing.wasm';\nimport {leaf} from '../../packages/x/src/leaf.js';\nconsole.log(wasm, leaf);\n",
      'tools/cli/run.mjs': "import {other} from '../../packages/x/src/index.ts';\nconsole.log(other);\n",
      'tools/x/generate.mjs': "console.log('tests/fixtures/generated.json');\n",
      'tests/fixtures/sample.json': '{}\n',
      'tests/fixtures/dir/a.bin': 'a',
      'tests/fixtures/generated.json': '{}\n',
      'compat/behavior-specs/x/cases.json': '[]\n',
      'compat/behavior-specs/y.json': '[]\n',
    };
    for (const [file, text] of Object.entries(sources)) write(file, text);
    const tracked = Object.keys(sources).sort();
    const config = { fastLane: { registryTest: 'registry', allTestsWhenChanged: ['package-lock.json'] } };
    const run = (changed, files = tracked) => affectedTests({ root, base: 'unused', files, config, changed });
    const always = ['tests/unit/x-registry.test.ts'];
    const tests = async changed => (await run(changed)).tests;
    expect(await tests(['packages/x/src/leaf.ts'])).toEqual(['tests/unit/direct.test.ts', 'tests/unit/spawn.test.ts', 'tests/unit/through-hub.test.ts', 'tests/unit/workers-fixture.test.ts', 'tests/unit/workspace-type.test.ts', ...always].sort());
    expect(await tests(['packages/x/src/other.ts'])).toEqual(['tests/unit/spawn.test.ts', 'tests/unit/through-hub.test.ts', 'tests/unit/workspace-type.test.ts', ...always].sort());
    expect(await tests(['packages/x/src/registry.ts'])).toEqual(['tests/unit/spawn.test.ts', 'tests/unit/through-hub.test.ts', 'tests/unit/workspace-type.test.ts', ...always].sort());
    // Type-only imports, which esbuild drops: by relative path and by workspace specifier.
    expect(await tests(['packages/x/src/types.ts'])).toEqual(['tests/unit/type-only.test.ts', ...always].sort());
    expect(await tests(['compat/behavior-specs/x/cases.json'])).toEqual(['tests/unit/corpus.test.ts', 'tests/unit/template.test.ts', ...always].sort());
    expect(await tests(['compat/behavior-specs/y.json'])).toEqual(['tests/unit/template.test.ts', ...always].sort());
    expect(await tests(['tests/fixtures/sample.json'])).toEqual(['tests/unit/relative.test.ts', ...always].sort());
    expect(await tests(['tests/fixtures/dir/a.bin'])).toEqual(['tests/unit/joined.test.ts', ...always].sort());
    expect(await tests(['tests/fixtures/generated.json'])).toEqual(['tests/unit/script.test.ts', ...always].sort());
    expect((await run(['packages/x/src/leaf.ts'])).chains['tests/unit/spawn.test.ts']).toEqual(['tests/unit/spawn.test.ts', 'tools/cli/run.mjs', 'packages/x/src/index.ts', 'packages/x/src/registry.ts', 'packages/x/src/leaf.ts']);
    // A deleted module: whatever still names it.
    expect(await (async () => (await run(['packages/x/src/leaf.ts'], tracked.filter(file => file !== 'packages/x/src/leaf.ts'))).tests)()).toEqual(expect.arrayContaining(['tests/unit/direct.test.ts', 'tests/unit/through-hub.test.ts']));
    expect((await run(['tests/unit/corpus.test.ts'])).reasons['tests/unit/corpus.test.ts']).toContain('changed');
    expect((await run(['package-lock.json'])).all).toBe(true);
    expect((await run(['packages/x/src/leaf.ts'])).missingImports).toEqual([{ from: 'tests/workers/x-fixture.ts', path: './missing.wasm' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('takes the branch point from an upstream base, never from an integration branch or a branch that already holds the commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'edgeffmpeg-branch-point-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    const commit = message => { writeFileSync(join(root, 'file'), message); git('add', 'file'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
    git('init', '-q');
    const base = commit('base'); git('update-ref', 'refs/remotes/origin/wave2/prep', base);
    commit('feature 1'); const feature = commit('feature 2');
    // The integration branch merged the feature (its merge base with the feature is the feature itself).
    git('update-ref', 'refs/remotes/origin/wave2/integration', feature);
    git('update-ref', 'refs/remotes/origin/ci-fast/copy', feature);
    const point = branchPoint(root, ['wave2/prep', '**/integration*', 'ci-fast/**'], { notBases: ['**/integration*'], current: 'wave2/feature' });
    expect(point).toMatchObject({ base: 'wave2/prep', mergeBase: base, distance: 2 });
    expect(point.rejected).toEqual([{ base: 'wave2/integration', reason: 'integration branch' }, { base: 'ci-fast/copy', reason: 'already contains HEAD' }]);
    // Without notBases the integration branch still does not hide the change, because it already contains HEAD.
    expect(branchPoint(root, ['**/integration*', 'wave2/prep'], { current: 'wave2/feature' })).toMatchObject({ base: 'wave2/prep', distance: 2 });
    expect(fastPlan(['tests/unit/a.test.ts', 'tests/unit/b.test.ts'], { base: 'wave2/prep', mergeBase: base, all: false, changed: ['x'], tests: ['tests/unit/a.test.ts'], reasons: { 'tests/unit/a.test.ts': ['changed'] }, chains: {} },
      { config: { profile: 'linux-x64', shards: { unit: 1, integration: 1, differential: 1, workers: 1 }, fastLane: { shardSeconds: 360 } }, durations: { profiles: {} } }).suites.unit).toEqual([['tests/unit/a.test.ts']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
