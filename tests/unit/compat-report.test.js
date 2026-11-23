import { expect, it } from 'vitest';
import { summarizeSuite, summarizeCapabilities, summarizeContracts, validationStatus } from '../../tools/compatibility-report/summarize.mjs';
function raw(status = 'passed') { return { success: true, numTotalTests: 1, numPassedTests: status === 'passed' ? 1 : 0, numFailedTests: status === 'failed' ? 1 : 0, testResults: [{ name: '/repo/tests/unit/a.test.ts', status: 'passed', assertionResults: [{ fullName: 'case a', status }] }] }; }
it('rejects inconsistent or missing test evidence even when a runner claims success', () => {
  expect(summarizeSuite(raw(), ['tests/unit/a.test.ts'], '/repo').status).toBe('passed');
  expect(summarizeSuite(raw('skipped'), ['tests/unit/a.test.ts'], '/repo').status).toBe('failed');
  expect(summarizeSuite(raw(), ['tests/unit/a.test.ts','tests/unit/missing.test.ts'], '/repo').missingFiles).toEqual(['tests/unit/missing.test.ts']);
  expect(() => summarizeSuite({ ...raw(), numTotalTests: 2 }, ['tests/unit/a.test.ts'], '/repo')).toThrow('count mismatch');
  expect(() => summarizeSuite(raw(), [], '/repo')).toThrow('Unexpected');
});
it('does not promote partial capabilities when their referenced files pass', () => {
  const unit = summarizeSuite(raw(), ['tests/unit/a.test.ts'], '/repo');
  const report = summarizeCapabilities([{ id: 'decoder.example', kind: 'decoder', implementation: 'partial', testCases: ['tests/unit/a.test.ts'], notes: 'Restricted input subset' }], { unit });
  expect(report.states.partial).toBe(1); expect(report.states.bitexact).toBe(0); expect(report.unverifiedConformance).toBe(1);
  expect(report.withPassingReferencedFiles).toBe(1);
});
it('matches scoped comparison contracts by exact file and test name', () => {
  const unit = summarizeSuite(raw(), ['tests/unit/a.test.ts'], '/repo');
  const contract = { id: 'a', file: 'tests/unit/a.test.ts', name: 'case a', modes: ['bit-exact-pcm'], scope: 'Only fixture a payload' };
  expect(summarizeContracts([contract], { unit })[0].status).toBe('passed');
  expect(summarizeContracts([{ ...contract, name: 'absent' }], { unit })[0].status).toBe('unverified');
  expect(summarizeContracts([contract], { unit: { ...unit, status: 'failed' } })[0].status).toBe('failed');
});
it('fails validation on a changed source snapshot, missing runtime suite or failed gate', () => {
  const suites = Object.fromEntries(['unit','integration','differential','workers'].map(name => [name, { status: 'passed' }]));
  expect(validationStatus([{ status: 'passed' }], suites, true)).toBe('passed');
  expect(validationStatus([{ status: 'passed' }], suites, false)).toBe('failed');
  expect(validationStatus([{ status: 'failed' }], suites, true)).toBe('failed');
  expect(validationStatus([{ status: 'passed' }], { unit: suites.unit }, true)).toBe('failed');
});
it('detects changes to reference artifacts independently of source contents', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { snapshotReference } = await import('../../tools/compatibility-report/source.mjs');
  const root = mkdtempSync(join(tmpdir(), 'edgeffmpeg-evidence-'));
  try {
    mkdirSync(join(root, '.build/reference'), { recursive: true });
    for (const name of ['ffmpeg','ffprobe','build-metadata.json']) writeFileSync(join(root, '.build/reference', name), name);
    const before = snapshotReference(root);
    writeFileSync(join(root, '.build/reference/ffprobe'), 'replaced');
    expect(snapshotReference(root)).not.toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { summarizeFateExecution } from '../../tools/compatibility-report/summarize.mjs';
it('requires fresh complete reviewed FATE evidence rather than inventory or stale results',()=>{
  const profile={id:'fate-example',sha256:'profile',input:{sha256:'input',bytes:2},md5:'expected'};
  const inventory={cases:[{id:'fate-example'},{id:'fate-unported'}]},reference={ffmpeg:'native'};
  const raw={schemaVersion:1,status:'passed',sourceSha256:'source',referenceArtifacts:reference,cases:[{id:profile.id,status:'passed',profileSha256:profile.sha256,input:profile.input,output:{md5:'expected',sha256:'a'.repeat(64),bytes:2}}]};
  expect(summarizeFateExecution(raw,inventory,[profile],'source',reference)).toMatchObject({executedDefinitions:1,unexecutedDefinitions:1});
  for(const invalid of [{...raw,sourceSha256:'stale'},{...raw,status:'failed'},{...raw,cases:[]},{...raw,cases:[...raw.cases,...raw.cases]},{...raw,referenceArtifacts:{ffmpeg:'changed'}},{...raw,cases:[{...raw.cases[0],output:{md5:'wrong',sha256:'a'.repeat(64),bytes:2}}]}])expect(()=>summarizeFateExecution(invalid,inventory,[profile],'source',reference)).toThrow();
});

it('requires full expected framecrc bytes for every registered FATE profile',()=>{
  const profile={id:'fate-asetrate',sha256:'profile',comparison:'framecrc',input:{sha256:'input',bytes:2},expectedOutput:{sha256:'a'.repeat(64),bytes:20}};
  const inventory={cases:[{id:profile.id}]},reference={ffmpeg:'native'};
  const raw={schemaVersion:1,status:'passed',sourceSha256:'source',referenceArtifacts:reference,cases:[{id:profile.id,status:'passed',profileSha256:profile.sha256,input:profile.input,output:{sha256:'a'.repeat(64),bytes:20}}]};
  expect(summarizeFateExecution(raw,inventory,[profile],'source',reference).executedDefinitions).toBe(1);
  expect(()=>summarizeFateExecution({...raw,cases:[{...raw.cases[0],output:{sha256:'b'.repeat(64),bytes:20}}]},inventory,[profile],'source',reference)).toThrow();
  expect(()=>summarizeFateExecution({...raw,cases:[{...raw.cases[0],output:{sha256:'a'.repeat(64),bytes:19}}]},inventory,[profile],'source',reference)).toThrow();
});
