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

import { platformPolicy, runPlatform } from '../../tools/compatibility-report/summarize.mjs';
const gatedFile = 'tests/differential/g.test.ts';
function gatedRaw(cases) {
  const tests = cases.map(([fullName, status]) => ({ fullName, status })), failed = tests.filter(test => test.status === 'failed').length;
  return { success: failed === 0, numTotalTests: tests.length, numPassedTests: tests.filter(test => test.status === 'passed').length, numFailedTests: failed,
    testResults: [{ name: `/repo/${gatedFile}`, status: failed ? 'failed' : 'passed', assertionResults: tests }] };
}
const linuxOnly = { id: 'g.linux', file: gatedFile, name: 'linux case', modes: ['bit-exact'], scope: 'linux/x64 only', platforms: ['linux-x64'] };
const everywhere = { id: 'g.all', file: gatedFile, name: 'portable case', modes: ['bit-exact'], scope: 'every platform' };
it('reports a declared platform-gated skip as not applicable only on platforms the contract does not list', () => {
  const raw = gatedRaw([['portable case', 'passed'], ['linux case', 'skipped']]);
  const mac = summarizeSuite(raw, [gatedFile], '/repo', platformPolicy([linuxOnly, everywhere], 'darwin-arm64'));
  expect(mac).toMatchObject({ status: 'passed-with-not-applicable', platform: 'darwin-arm64', total: 2, passed: 1, failed: 0, skipped: 1, notApplicable: 1, unexpectedSkips: 0 });
  expect(mac.files).toEqual([{ file: gatedFile, status: 'passed-with-not-applicable', tests: 2, notApplicable: 1 }]);
  expect(mac.assertions[1]).toMatchObject({ status: 'skipped', outcome: 'not-applicable', requiredPlatforms: ['linux-x64'] });
  const contracts = summarizeContracts([linuxOnly, everywhere], { differential: mac }, 'darwin-arm64');
  expect(contracts.map(contract => [contract.id, contract.status, contract.platform])).toEqual([['g.linux', 'not-applicable', 'darwin-arm64'], ['g.all', 'passed', 'darwin-arm64']]);
  expect(contracts[0]).toMatchObject({ observed: 'skipped', platforms: ['linux-x64'] });
  // The same skip on a listed platform is unexpected and fails the file, the suite and the contract.
  const linux = summarizeSuite(raw, [gatedFile], '/repo', platformPolicy([linuxOnly, everywhere], 'linux-x64'));
  expect(linux).toMatchObject({ status: 'failed', notApplicable: 0, unexpectedSkips: 1 });
  expect(linux.files[0].status).toBe('failed');
  expect(summarizeContracts([linuxOnly, everywhere], { differential: linux }, 'linux-x64').map(contract => contract.status)).toEqual(['failed', 'failed']);
  // On a listed platform the gated test must run and pass.
  const linuxRan = summarizeSuite(gatedRaw([['portable case', 'passed'], ['linux case', 'passed']]), [gatedFile], '/repo', platformPolicy([linuxOnly, everywhere], 'linux-x64'));
  expect(linuxRan.status).toBe('passed');
  expect(summarizeContracts([linuxOnly, everywhere], { differential: linuxRan }, 'linux-x64').map(contract => contract.status)).toEqual(['passed', 'passed']);
});
it('fails every skip that no platform-gated contract declares for this platform', () => {
  const policy = platformPolicy([linuxOnly, everywhere], 'darwin-arm64');
  const fails = cases => summarizeSuite(gatedRaw(cases), [gatedFile], '/repo', policy);
  expect(fails([['portable case', 'passed'], ['undeclared case', 'skipped']])).toMatchObject({ status: 'failed', notApplicable: 0, unexpectedSkips: 1 });
  expect(fails([['portable case', 'skipped'], ['linux case', 'skipped']])).toMatchObject({ status: 'failed', notApplicable: 1, unexpectedSkips: 1 });
  for (const status of ['todo', 'pending', 'disabled']) expect(fails([['portable case', 'passed'], ['linux case', status]])).toMatchObject({ status: 'failed', unexpectedSkips: 1 });
  // A second contract that requires the same test everywhere keeps its skip unexpected.
  const shared = platformPolicy([linuxOnly, { ...everywhere, id: 'g.same', name: 'linux case' }], 'darwin-arm64');
  expect(summarizeSuite(gatedRaw([['linux case', 'skipped']]), [gatedFile], '/repo', shared)).toMatchObject({ status: 'failed', unexpectedSkips: 1 });
  // Without a policy, or without a known platform, no skip is accepted and gated contracts still apply.
  const raw = gatedRaw([['portable case', 'passed'], ['linux case', 'skipped']]);
  expect(summarizeSuite(raw, [gatedFile], '/repo').status).toBe('failed');
  const unknown = summarizeSuite(raw, [gatedFile], '/repo', platformPolicy([linuxOnly, everywhere], null));
  expect(unknown).toMatchObject({ status: 'failed', unexpectedSkips: 1 });
  expect(summarizeContracts([linuxOnly, everywhere], { differential: unknown }).map(contract => contract.status)).toEqual(['failed', 'failed']);
  expect(summarizeContracts([{ ...linuxOnly, name: 'absent' }], { differential: unknown })[0].status).toBe('unverified');
  // A file whose only tests are not applicable is not a passing file, and a suite with no passed test cannot pass validation.
  const onlyGated = summarizeSuite(gatedRaw([['linux case', 'skipped']]), [gatedFile], '/repo', policy);
  expect(onlyGated).toMatchObject({ status: 'not-applicable', passed: 0, notApplicable: 1 });
  const suites = Object.fromEntries(['unit', 'integration', 'workers'].map(name => [name, { status: 'passed' }]));
  expect(validationStatus([{ status: 'passed' }], { ...suites, differential: onlyGated }, true)).toBe('failed');
  expect(validationStatus([{ status: 'passed' }], { ...suites, differential: { status: 'passed-with-not-applicable' } }, true)).toBe('passed');
});
it('never counts a platform-gated skip as evidence of passing', () => {
  const mac = summarizeSuite(gatedRaw([['portable case', 'passed'], ['linux case', 'skipped']]), [gatedFile], '/repo', platformPolicy([linuxOnly, everywhere], 'darwin-arm64'));
  const capabilities = summarizeCapabilities([{ id: 'filter.g', kind: 'filter', implementation: 'partial', testCases: [gatedFile] }], { differential: mac });
  expect(capabilities.withPassingReferencedFiles).toBe(0);
  // An absent gated test on an unlisted platform is not applicable, never passed; a gated test that runs there counts normally.
  expect(summarizeContracts([{ ...linuxOnly, name: 'renamed' }], { differential: mac }, 'darwin-arm64')[0]).toMatchObject({ status: 'not-applicable', observed: 'absent' });
  const ranOnMac = summarizeSuite(gatedRaw([['linux case', 'failed']]), [gatedFile], '/repo', platformPolicy([linuxOnly], 'darwin-arm64'));
  expect(summarizeContracts([linuxOnly], { differential: ranOnMac }, 'darwin-arm64')[0].status).toBe('failed');
});
it('validates the platforms declaration and derives the run platform from host and reference', () => {
  for (const platforms of [[], 'linux-x64', ['linux-x86_64'], ['linux/x64'], ['linux-x64', 'linux-x64'], [7]]) expect(() => platformPolicy([{ ...linuxOnly, platforms }], 'linux-x64')).toThrow('Invalid platforms');
  expect(() => summarizeContracts([{ ...linuxOnly, platforms: ['Linux-x64'] }], {}, 'linux-x64')).toThrow('Invalid platforms');
  expect(platformPolicy([{ ...linuxOnly, platforms: ['linux-x64', 'darwin-arm64'] }], 'darwin-arm64').platform).toBe('darwin-arm64');
  expect(runPlatform({ platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'arm64' })).toMatchObject({ host: 'darwin-arm64', reference: 'darwin-arm64', policy: 'darwin-arm64' });
  expect(runPlatform({ platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' })).toMatchObject({ host: 'darwin-x64', reference: 'darwin-arm64', policy: null });
  expect(runPlatform({ platform: 'linux', arch: 'x64' }, null)).toMatchObject({ host: 'linux-x64', reference: null, policy: null });
  // A policy built from a run platform whose host and reference differ accepts no gated skip.
  const mismatch = platformPolicy([linuxOnly], runPlatform({ platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' }));
  expect(mismatch).toMatchObject({ platform: null, host: 'darwin-x64' });
  expect(summarizeSuite(gatedRaw([['linux case', 'skipped']]), [gatedFile], '/repo', mismatch)).toMatchObject({ status: 'failed', platform: 'darwin-x64', unexpectedSkips: 1 });
});
it('accepts the platform declarations in compat/test-contracts.json', async () => {
  const { readFileSync } = await import('node:fs');
  const contracts = JSON.parse(readFileSync(new URL('../../compat/test-contracts.json', import.meta.url), 'utf8'));
  expect(() => platformPolicy(contracts, 'darwin-arm64')).not.toThrow();
  for (const contract of contracts.filter(contract => contract.platforms)) expect(contract.scope).toContain('reported there as not applicable');
});
it('states the producing platform for every suite and contract row and lists unexpected skips', async () => {
  const { renderMarkdown } = await import('../../tools/compatibility-report/render.mjs');
  const platform = runPlatform({ platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'arm64' });
  const differential = summarizeSuite(gatedRaw([['portable case', 'passed'], ['linux case', 'skipped'], ['other case', 'skipped']]), [gatedFile], '/repo', platformPolicy([linuxOnly, everywhere], platform));
  const contracts = summarizeContracts([linuxOnly, everywhere], { differential }, platform);
  const markdown = renderMarkdown({ runId: 'run', finishedAt: 'now', developmentValidation: 'failed', platform, suites: { differential }, contracts, gates: [],
    notApplicable: { contracts: 1, requiredPlatforms: ['linux-x64'] } });
  expect(markdown).toContain('Development validation on darwin-arm64: **failed**');
  expect(markdown).toContain('Platform: darwin-arm64 (reference build: darwin-arm64; platform gating: darwin-arm64)');
  expect(markdown).toContain('| differential | darwin-arm64 | failed | 1 | 0 | 1 | 1 | 3 |');
  expect(markdown).toContain(`- ${gatedFile}: other case (skipped)`);
  expect(markdown).toContain('| g.linux | not-applicable | darwin-arm64 | linux-x64 | bit-exact | linux/x64 only |');
  expect(markdown).toContain('| g.all | failed | darwin-arm64 | all | bit-exact | every platform |');
  expect(markdown).toContain('Not applicable on darwin-arm64: 1 contract, not counted as passed. They resolve only on a run on linux-x64.');
});
