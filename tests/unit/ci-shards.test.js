import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { planShards, validatePlan, shardMatrix, laneFor, suiteFiles, SUITES } from '../../tools/ci/plan.mjs';
import { readShardDirectory, collectSuite } from '../../tools/compatibility-report/shards.mjs';
import { summarizeSuite } from '../../tools/compatibility-report/summarize.mjs';
import { globMatcher, affectedTests } from '../../tools/ci/affected.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
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
  const context = { root, directory, evidence, plan: shardPlan, expected: unitFiles, policy: undefined, before: { sha256: 'source', revision: 'commit' }, referenceBefore: { ffmpeg: 'native' }, platform: { host: `${process.platform}-${process.arch}` } };
  const shards = shardPlan.suites.unit.map((list, position) => {
    const id = `unit-${position + 1}`;
    const raw = { success: true, numTotalTests: list.length, numPassedTests: list.length, numFailedTests: 0, testResults: list.map(file => ({ name: `${root}/${file}`, status: 'passed', assertionResults: [{ fullName: `case ${file}`, status: 'passed' }] })) };
    const meta = { schemaVersion: 1, kind: 'edgeffmpeg-test-shard', id, suite: 'unit', index: position + 1, count: shardPlan.suites.unit.length, planMode: 'full', planSha256: shardPlan.sha256, files: list, command: ['npx', 'vitest', 'run'], exitCode: 0, signal: null, durationMs: 5, log: `${id}.log`, report: `${id}.json`, root, revision: 'commit', sourceBefore: 'source', sourceAfter: 'source', referenceBefore: { ffmpeg: 'native' }, referenceAfter: { ffmpeg: 'native' }, platform: { host: context.platform.host }, environment: { node: process.version, platform: process.platform, arch: process.arch } };
    return { id, raw, meta, log: `log ${id}\n` };
  });
  mutate({ shards, context });
  for (const shard of shards) {
    const report = JSON.stringify(shard.raw);
    writeFileSync(join(directory, `${shard.id}.json`), report); writeFileSync(join(directory, `${shard.id}.log`), shard.log);
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
  check(({ shards }) => { shards[1].meta.sourceAfter = 'edited'; }, result => { expect(result.sourceStable).toBe(false); expect(result.referenceStable).toBe(true); });
  check(({ shards }) => { shards[1].meta.referenceBefore = { ffmpeg: 'other' }; }, result => expect(result.referenceStable).toBe(false));
  const { root: other } = fixture();
  try { expect(() => { writeFileSync(join(other, 'shards', 'unit-9x.shard.json'), '{}'); readShardDirectory(join(other, 'shards')); }).toThrow('Unexpected shard record'); } finally { rmSync(other, { recursive: true, force: true }); }
});
it('selects changed tests, registry tests and tests that reach a changed module except through a hub', async () => {
  const root = mkdtempSync(join(tmpdir(), 'edgeffmpeg-affected-'));
  try {
    const write = (file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
    write('packages/x/src/leaf.ts', 'export const leaf = 1;\n');
    write('packages/x/src/registry.ts', "export {leaf} from './leaf.js';\n");
    write('tests/helpers/use.ts', "export {leaf} from '../../packages/x/src/leaf.js';\n");
    write('tests/unit/direct.test.ts', "import {leaf} from '../helpers/use.js';\nconsole.log(leaf);\n");
    write('tests/unit/through-hub.test.ts', "import {leaf} from '../../packages/x/src/registry.js';\nconsole.log(leaf);\n");
    write('tests/unit/x-registry.test.ts', "console.log('registry');\n");
    write('tests/unit/corpus.test.ts', "const path = 'compat/behavior-specs/x/cases.json';\nconsole.log(path);\n");
    write('compat/behavior-specs/x/cases.json', '[]\n');
    const tracked = ['packages/x/src/leaf.ts', 'packages/x/src/registry.ts', 'tests/helpers/use.ts', 'tests/unit/direct.test.ts', 'tests/unit/through-hub.test.ts', 'tests/unit/x-registry.test.ts', 'tests/unit/corpus.test.ts', 'compat/behavior-specs/x/cases.json'];
    const config = { fastLane: { registryTest: 'registry', hubs: ['packages/**/registry.ts'], allTestsWhenChanged: ['package.json'] } };
    const run = changed => affectedTests({ root, base: 'unused', files: tracked, config, changed });
    expect((await run(['packages/x/src/leaf.ts'])).tests).toEqual(['tests/unit/direct.test.ts', 'tests/unit/x-registry.test.ts']);
    expect((await run(['packages/x/src/registry.ts'])).tests).toEqual(['tests/unit/x-registry.test.ts']);
    expect((await run(['compat/behavior-specs/x/cases.json'])).tests).toEqual(['tests/unit/corpus.test.ts', 'tests/unit/x-registry.test.ts']);
    expect((await run(['tests/unit/corpus.test.ts'])).reasons['tests/unit/corpus.test.ts']).toContain('changed');
    expect(await run(['package.json'])).toMatchObject({ all: true, tests: ['tests/unit/corpus.test.ts', 'tests/unit/direct.test.ts', 'tests/unit/through-hub.test.ts', 'tests/unit/x-registry.test.ts'] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
