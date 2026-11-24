import { relative, isAbsolute } from 'node:path';
/** Node `process.platform`-`process.arch` identifiers that a contract may list in `platforms`. */
const PLATFORM_ID = /^(aix|android|cygwin|darwin|freebsd|haiku|linux|netbsd|openbsd|sunos|win32)-(arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)$/;
export const platformId = (platform, arch) => `${platform}-${arch}`;
/** Suite and file statuses that contain no failure and at least one passed test. */
export const passing = status => status === 'passed' || status === 'passed-with-not-applicable';
/**
 * The platform a run reports. Platform gating applies only when the host and the native
 * reference build agree on a known platform; otherwise `policy` is null and every skip fails.
 */
export function runPlatform(host, reference) {
  const hostId = platformId(host?.platform, host?.arch);
  const referenceId = typeof reference?.platform === 'string' && typeof reference?.arch === 'string' ? platformId(reference.platform, reference.arch) : null;
  const policy = PLATFORM_ID.test(hostId) && referenceId === hostId ? hostId : null;
  return { host: hostId, reference: referenceId, policy,
    reason: policy ? 'Host and reference build agree' : referenceId === null ? 'No validated reference build metadata: platform-gated skips are not accepted' : `Host ${hostId} and reference build ${referenceId} differ: platform-gated skips are not accepted` };
}
function validateContracts(contracts) {
  if (!Array.isArray(contracts)) throw new Error('Invalid comparison contract list');
  const ids = new Set();
  for (const contract of contracts) {
    if (!contract.id || ids.has(contract.id) || !contract.scope || !Array.isArray(contract.modes)) throw new Error('Invalid or duplicate comparison contract');
    if (Object.hasOwn(contract, 'platforms') && (!Array.isArray(contract.platforms) || !contract.platforms.length || new Set(contract.platforms).size !== contract.platforms.length || !contract.platforms.every(id => typeof id === 'string' && PLATFORM_ID.test(id)))) throw new Error(`Invalid platforms for comparison contract ${contract.id}`);
    ids.add(contract.id);
  }
}
/** Accepts a platform id, or a `runPlatform` result whose `policy` may be null. */
function normalizePlatform(platform) {
  if (typeof platform === 'string') return { host: platform, policy: PLATFORM_ID.test(platform) ? platform : null };
  return { host: typeof platform?.host === 'string' ? platform.host : null, policy: typeof platform?.policy === 'string' && PLATFORM_ID.test(platform.policy) ? platform.policy : null };
}
/**
 * Skip policy derived from the contracts. A skipped test is not applicable only when at least one
 * contract names it, every contract naming it declares `platforms`, and none lists the run's platform.
 */
export function platformPolicy(contracts, platform) {
  validateContracts(contracts);
  const { host, policy } = normalizePlatform(platform);
  const tests = new Map();
  for (const contract of contracts) {
    const key = `${contract.file}\0${contract.name}`, entry = tests.get(key) ?? { everywhere: false, platforms: new Set() };
    if (contract.platforms) for (const id of contract.platforms) entry.platforms.add(id); else entry.everywhere = true;
    tests.set(key, entry);
  }
  return { platform: policy, host, tests };
}
const strictPolicy = { platform: null, host: null, tests: new Map() };
function outcome(file, assertion, policy) {
  if (assertion.status === 'passed' || assertion.status === 'failed') return { outcome: assertion.status };
  const entry = policy.tests.get(`${file}\0${assertion.fullName}`);
  if (assertion.status === 'skipped' && policy.platform && entry && !entry.everywhere && entry.platforms.size && !entry.platforms.has(policy.platform)) return { outcome: 'not-applicable', requiredPlatforms: [...entry.platforms].sort() };
  return { outcome: 'unexpected-skip' };
}
function aggregate(failed, notApplicable, passed) {
  return failed ? 'failed' : notApplicable === 0 ? 'passed' : passed === 0 ? 'not-applicable' : 'passed-with-not-applicable';
}
export function summarizeSuite(raw, expectedFiles, root, policy = strictPolicy) {
  if (!raw || !Array.isArray(raw.testResults)) throw new Error('Missing Vitest test results');
  const files = [], assertions = [], seen = new Set();
  for (const entry of raw.testResults) {
    const file = relative(root, entry.name).replaceAll('\\', '/');
    if (isAbsolute(file) || file.startsWith('../') || seen.has(file) || !expectedFiles.includes(file) || !Array.isArray(entry.assertionResults)) throw new Error('Unexpected or duplicate test file');
    seen.add(file);
    const cases = entry.assertionResults.map(assertion => {
      if (!['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'].includes(assertion.status) || typeof assertion.fullName !== 'string') throw new Error('Invalid test assertion');
      return { file, name: assertion.fullName, status: assertion.status, ...outcome(file, assertion, policy) };
    });
    assertions.push(...cases);
    const count = name => cases.filter(test => test.outcome === name).length;
    const failedFile = entry.status !== 'passed' || cases.length === 0 || count('failed') > 0 || count('unexpected-skip') > 0;
    files.push({ file, status: aggregate(failedFile, count('not-applicable'), count('passed')), tests: cases.length, notApplicable: count('not-applicable') });
  }
  const missingFiles = expectedFiles.filter(file => !seen.has(file));
  const passed = assertions.filter(test => test.status === 'passed').length;
  const failed = assertions.filter(test => test.status === 'failed').length;
  const notApplicable = assertions.filter(test => test.outcome === 'not-applicable').length;
  const unexpectedSkips = assertions.filter(test => test.outcome === 'unexpected-skip').length;
  if (assertions.length !== raw.numTotalTests || passed !== raw.numPassedTests || failed !== raw.numFailedTests) throw new Error('Vitest count mismatch');
  const failedSuite = raw.success !== true || assertions.length === 0 || missingFiles.length > 0 || files.some(file => file.status === 'failed');
  return { status: aggregate(failedSuite, notApplicable, passed), platform: policy.host ?? null, total: assertions.length, passed, failed, skipped: assertions.length - passed - failed, notApplicable, unexpectedSkips, missingFiles, files, assertions };
}
export function summarizeCapabilities(capabilities, suites) {
  if (!Array.isArray(capabilities) || !capabilities.length) throw new Error('Missing capability manifest');
  const states = { unimplemented: 0, partial: 0, conformant: 0, bitexact: 0, 'runtime-blocked': 0 };
  const kinds = {}, ids = new Set(), testFiles = new Map();
  for (const suite of Object.values(suites)) for (const file of suite.files ?? []) testFiles.set(file.file, file.status === 'passed' && passing(suite.status));
  let withPassingReferencedFiles = 0;
  const differences = new Map();
  for (const feature of capabilities) {
    if (!Object.hasOwn(states, feature.implementation) || ids.has(feature.id) || !Array.isArray(feature.testCases)) throw new Error('Invalid capability entry');
    ids.add(feature.id); states[feature.implementation]++;
    kinds[feature.kind] ??= { total: 0, partial: 0, conformant: 0, bitexact: 0 };
    kinds[feature.kind].total++;
    if (Object.hasOwn(kinds[feature.kind], feature.implementation) && feature.implementation !== 'total') kinds[feature.kind][feature.implementation]++;
    if (feature.testCases.length && feature.testCases.every(file => testFiles.get(file) === true)) withPassingReferencedFiles++;
    if (feature.notes) { const group = differences.get(feature.notes) ?? []; group.push(feature.id); differences.set(feature.notes, group); }
  }
  return { total: capabilities.length, states, kinds, withPassingReferencedFiles,
    unverifiedConformance: states.unimplemented + states.partial + states['runtime-blocked'],
    knownDifferences: [...differences].map(([notes, features]) => ({ notes, features })),
    limitation: 'File-level test references are navigation evidence, not a proof that every behavior of a capability was tested. No status is upgraded by passing tests.' };
}
/**
 * Resolves each contract on `platform`. A contract whose `platforms` excludes it is `not-applicable`
 * when its test was skipped or is absent: neither passed nor failed, and never evidence of passing.
 * Without a known platform every contract applies, so a gated contract cannot become not applicable.
 */
export function summarizeContracts(contracts, suites, platform = null) {
  validateContracts(contracts);
  const tests = Object.values(suites).flatMap(suite => (suite.assertions ?? []).map(test => ({ ...test, suiteStatus: suite.status })));
  const policy = platformPolicy(contracts, platform);
  return contracts.map(contract => {
    const matches = tests.filter(test => test.file === contract.file && test.name === contract.name);
    const applicable = !contract.platforms || policy.platform === null || contract.platforms.includes(policy.platform);
    const observed = matches.length === 0 ? 'absent' : matches.length === 1 ? matches[0].status : 'duplicate';
    if (!applicable && (observed === 'absent' || observed === 'skipped')) return { ...contract, status: 'not-applicable', platform: policy.host, observed };
    const status = matches.length === 1 && matches[0].status === 'passed' && passing(matches[0].suiteStatus) ? 'passed' : matches.length === 0 ? 'unverified' : 'failed';
    return { ...contract, status, platform: policy.host };
  });
}
export function validationStatus(gates, suites, stableSource) {
  return stableSource && gates.length > 0 && gates.every(gate => gate.status === 'passed') && ['unit', 'integration', 'differential', 'workers'].every(name => passing(suites[name]?.status)) ? 'passed' : 'failed';
}
/** Fresh reviewed FATE execution is separate from the unported Make inventory. */
export function summarizeFateExecution(raw, inventory, profiles, sourceSha256, referenceArtifacts) {
  const required = profiles.map(profile=>profile.id);
  if (!profiles.length || new Set(required).size!==required.length || raw?.schemaVersion!==1 || raw.status!=='passed' || raw.sourceSha256!==sourceSha256 || JSON.stringify(raw.referenceArtifacts)!==JSON.stringify(referenceArtifacts) || !Array.isArray(raw.cases) || raw.cases.length!==profiles.length) throw new Error('Invalid FATE execution provenance');
  const seen=new Set();
  for(const entry of raw.cases) {
    const profile=profiles.find(profile=>profile.id===entry.id);
    if (!profile || seen.has(entry.id) || entry.status!=='passed' || entry.profileSha256!==profile.sha256 || entry.input?.sha256!==profile.input.sha256 || entry.input?.bytes!==profile.input.bytes || (profile.comparison==='framecrc' ? entry.output?.sha256!==profile.expectedOutput?.sha256 || entry.output?.bytes!==profile.expectedOutput?.bytes : entry.output?.md5!==profile.md5) || !/^[a-f0-9]{64}$/.test(entry.output?.sha256??'') || !Number.isSafeInteger(entry.output?.bytes) || entry.output.bytes<0 || !inventory.cases.some(test=>test.id===entry.id)) throw new Error('Invalid or missing reviewed FATE case');
    seen.add(entry.id);
  }
  return {status:'passed',explicitCommandDefinitions:inventory.cases.length,executedDefinitions:raw.cases.length,unexecutedDefinitions:inventory.cases.length-raw.cases.length,cases:raw.cases,limitation:'Reviewed adapter profiles only; original native FATE helper and adapted Edge execution are compared with pinned input and expected results. Other explicit commands remain unported; generated Make targets are not included.'};
}
