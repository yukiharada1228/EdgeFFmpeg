import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createManifest, isAllowedPath, planShards, PORTABLE_TESTS, FLAC_TESTS, FLAC_DEPENDENCIES, stageManifest, validateTestDependencies } from './manifest.mjs';

test('portable job state and specification tests remain explicit and exclude runtime executors', () => {
  assert.equal(PORTABLE_TESTS.length, 68);
  assert.ok(PORTABLE_TESTS.includes('tests/unit/durable-media-job.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-job-spec.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-job-workflow-fence.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-workflow-plan.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-workflow-spec.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-workflow-control.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/distributed-planner.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/planner.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-workflow-graph.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/command-graph.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/complex-command-graph.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/checkpoint.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-checkpoint-state.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-checkpoint-artifacts.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/reframe-checkpoint.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-workflow-complex-graph.test.ts'));
  assert.ok(PORTABLE_TESTS.includes('tests/unit/media-workflow-command-graph.test.ts'));
  assert.equal(isAllowedPath('tests/unit/media-job-executor.test.ts'), false);
});

test('FLAC suite selects only enumerated recorded dependencies and rejects unknown suites', () => {
  assert.throws(() => isAllowedPath('package.json', 'all-tests'), /Unsupported validation suite/);
  assert.equal(FLAC_TESTS.length, 32);
  assert.ok(FLAC_TESTS.includes('tests/unit/flac-aformat-constraints.test.ts'));
  assert.ok(FLAC_TESTS.includes('tests/unit/flac-aformat-rate.test.ts'));
  assert.ok(FLAC_TESTS.includes('tests/unit/flac-timed-buffered.test.ts'));
  assert.ok(FLAC_TESTS.includes('tests/unit/flac-timed-aformat.test.ts'));
  assert.ok(FLAC_TESTS.includes('tests/unit/flac-timed-rate.test.ts'));
  assert.ok(FLAC_TESTS.includes('tests/unit/flac-copy-duration.test.ts'));
  assert.ok(FLAC_TESTS.includes('tests/unit/flac-timed-filters.test.ts'));
  for (const path of [...FLAC_TESTS, ...FLAC_DEPENDENCIES]) {
    assert.equal(isAllowedPath(path, 'flac-unit-v1'), true, path);
    assert.equal(isAllowedPath(path), false, path);
  }
  assert.equal(isAllowedPath('compat/behavior-specs/flac-decoder/cases.json', 'flac-unit-v1'), false);
  assert.equal(isAllowedPath('tests/unit/flac-decoder.test.ts', 'flac-unit-v1'), false);
});

test('allowlist rejects credentials, traversal, platform artifacts, and hidden paths', () => {
  for (const path of ['.env', '.hermes/auth.json', 'packages/a/.env', 'packages/a/token.json',
    'packages/a/private-key.json', 'packages/node_modules/a.ts', '../package.json',
    'packages/a/../secret.ts', '/package.json', 'packages\\a.ts', '.build/reference/ffmpeg',
    'upstream/ffmpeg/ffmpeg.c', 'tests/integration/native.test.ts']) assert.equal(isAllowedPath(path), false, path);
  for (const path of ['package.json', 'packages/avutil/src/index.ts', 'tools/modal/app.py', PORTABLE_TESTS[0]]) assert.equal(isAllowedPath(path), true, path);
});

test('stable sharding has no omissions, duplicates, or empty shards', () => {
  for (const count of [1, 16, 32]) {
    const shards = planShards(PORTABLE_TESTS, count);
    assert.equal(shards.length, count);
    assert.ok(shards.every(shard => shard.testFiles.length > 0));
    assert.deepEqual(shards.flatMap(shard => shard.testFiles).sort(), [...PORTABLE_TESTS]);
    assert.deepEqual(planShards([...PORTABLE_TESTS].reverse(), count), shards);
  }
  for (const count of [0, 33, 1.5, NaN]) assert.throws(() => planShards(PORTABLE_TESTS, count));
});

test('manifest snapshots tracked and untracked source, stages hashes, and refuses stale or linked inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'edge-modal-manifest-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const path of [...PORTABLE_TESTS, 'package.json', 'package-lock.json', 'tsconfig.json',
      'tsconfig.node.json', 'tsconfig.tests.json', 'tsconfig.workers.json', 'vitest.config.mjs', 'compat/reference-container.lock.json',
      'tests/helpers/output.ts', 'tests/helpers/wav.ts',
      'packages/example/src/index.ts', '.env']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), '{}');
    }
    execFileSync('git', ['add', 'package.json'], { cwd: root });
    const manifest = createManifest(root);
    assert.deepEqual(manifest, createManifest(root));
    assert.ok(manifest.source.files.some(file => file.path === 'packages/example/src/index.ts'));
    assert.ok(!manifest.source.files.some(file => file.path === '.env'));
    const stage = join(root, 'stage');
    stageManifest(root, stage, manifest);
    assert.deepEqual(JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8')), manifest);
    assert.throws(() => stageManifest(root, stage, manifest));
    writeFileSync(join(root, PORTABLE_TESTS[0]), "import {missing} from '../helpers/not-staged.js';");
    assert.throws(() => validateTestDependencies(root, manifest.source.files), /dependency omitted/);
    writeFileSync(join(root, 'packages/example/src/index.ts'), 'changed');
    assert.throws(() => stageManifest(root, join(root, 'stale'), manifest), /changed during staging/);
    symlinkSync(join(root, '.env'), join(root, 'packages/example/src/link.ts'));
    assert.throws(() => createManifest(root), /symlink source rejected/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
