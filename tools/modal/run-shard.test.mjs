import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { safePath, sourceDigest, validateInputs, assertionRecords, packageVersions, reportDiagnostics } from './run-shard.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'edge-modal-runner-'));
  try {
    await mkdir(join(root, 'tests/unit'), { recursive: true });
    await writeFile(join(root, 'tests/unit/example.test.ts'), 'example');
    const files = [{ path: 'tests/unit/example.test.ts', sha256: hash('example'), bytes: 7 }];
    const manifest = { schemaVersion: 1, suite: 'portable-unit-v1', source: { sha256: sourceDigest(files), files } };
    await fn(root, manifest, { id: 0, testFiles: ['tests/unit/example.test.ts'] });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('validates staged source and explicit test selection', () => fixture(async (root, manifest, shard) => { await validateInputs(root, manifest, shard); }));
test('rejects changed source instead of executing stale tests', () => fixture(async (root, manifest, shard) => {
  await writeFile(join(root, shard.testFiles[0]), 'changed');
  await assert.rejects(validateInputs(root, manifest, shard), /Source hash mismatch/);
}));
test('rejects missing fixtures and artifact hash mismatches', () => fixture(async (root, manifest, shard) => {
  manifest.requiredArtifacts = [{ path: '.build/missing.wasm' }];
  await assert.rejects(validateInputs(root, manifest, shard), /Required file missing/);
  manifest.requiredArtifacts = [{ path: shard.testFiles[0], sha256: '0'.repeat(64) }];
  await assert.rejects(validateInputs(root, manifest, shard), /Artifact hash mismatch/);
}));
test('rejects source inventory tampering and empty test selections', () => fixture(async (root, manifest, shard) => {
  manifest.source.sha256 = '0'.repeat(64);
  await assert.rejects(validateInputs(root, manifest, shard), /sourceHash mismatch/);
  manifest.source.sha256 = sourceDigest(manifest.source.files);
  await assert.rejects(validateInputs(root, manifest, { ...shard, testFiles: [] }), /explicit test files/);
}));
test('rejects traversal, options, unmanifested tests, duplicates, escaping symlinks', () => fixture(async (root, manifest, shard) => {
  for (const path of ['../secret', '/tmp/secret', 'tests/../secret', 'tests\\secret']) assert.throws(() => safePath(root, path), /Invalid|escapes/);
  await assert.rejects(validateInputs(root, manifest, { ...shard, testFiles: ['--help'] }), /not in source/);
  await assert.rejects(validateInputs(root, manifest, { ...shard, testFiles: [...shard.testFiles, ...shard.testFiles] }), /Duplicate/);
  await rm(join(root, shard.testFiles[0]));
  await symlink('/etc/hosts', join(root, shard.testFiles[0]));
  await assert.rejects(validateInputs(root, manifest, shard), /Symlink escapes/);
}));

test('accepts FLAC suite without relaxing source checks', () => fixture(async (root, manifest, shard) => {
  manifest.suite = 'flac-unit-v1';
  await validateInputs(root, manifest, shard);
  manifest.suite = 'unknown-suite';
  await assert.rejects(validateInputs(root, manifest, shard), /Unsupported/);
}));
test('retains every assertion identity and status', () => {
  assert.deepEqual(assertionRecords([{name:'/repo/tests/unit/a.test.ts',assertionResults:[
    {fullName:'outer passes',status:'passed',duration:3},
    {fullName:'outer fails',status:'failed',duration:null},
    {fullName:'outer skips',status:'pending'},
  ]}], '/repo'), [
    {id:'tests/unit/a.test.ts::outer passes',file:'tests/unit/a.test.ts',name:'outer passes',status:'passed',durationMs:3},
    {id:'tests/unit/a.test.ts::outer fails',file:'tests/unit/a.test.ts',name:'outer fails',status:'failed',durationMs:null},
    {id:'tests/unit/a.test.ts::outer skips',file:'tests/unit/a.test.ts',name:'outer skips',status:'pending',durationMs:null},
  ]);
});
test('records installed package versions and rejects missing dependencies', () => fixture(async root => {
  for (const [name, version] of [['vitest','5.1.1'],['typescript','6.0.0'],['esbuild','0.28.2']]) {
    await mkdir(join(root, 'node_modules', name), {recursive:true});
    await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({name,version}));
  }
  assert.deepEqual(await packageVersions(root), {vitest:'5.1.1',typescript:'6.0.0',esbuild:'0.28.2'});
  await rm(join(root, 'node_modules/esbuild/package.json'));
  await assert.rejects(packageVersions(root), /Required file missing/);
}));

test('retains import failures, missing files and unhandled errors with bounded messages', () => {
  const diagnostics = reportDiagnostics({success:false,unhandledErrors:[{message:'worker crashed'}],testResults:[
    {name:'/repo/tests/unit/import.test.ts',status:'failed',message:'Cannot find ../helpers/output.js',assertionResults:[]},
    {name:'/repo/tests/unit/long.test.ts',status:'failed',message:'x'.repeat(20000)},
  ]}, '/repo', ['tests/unit/import.test.ts','tests/unit/missing.test.ts']);
  assert.deepEqual(diagnostics.missingTestFiles,['tests/unit/missing.test.ts']);
  assert.equal(diagnostics.suiteFailures[0].message,'Cannot find ../helpers/output.js');
  assert.equal(diagnostics.suiteFailures[0].assertionCount,0);
  assert.equal(diagnostics.suiteFailures[1].message.length,16000);
  assert.match(diagnostics.unhandledErrors[0],/worker crashed/);
  assert.equal(diagnostics.reportSuccess,false);
});
