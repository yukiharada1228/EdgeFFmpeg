import { relative, isAbsolute } from 'node:path';
export function summarizeSuite(raw, expectedFiles, root) {
  if (!raw || !Array.isArray(raw.testResults)) throw new Error('Missing Vitest test results');
  const files = [], assertions = [], seen = new Set();
  for (const entry of raw.testResults) {
    const file = relative(root, entry.name).replaceAll('\\', '/');
    if (isAbsolute(file) || file.startsWith('../') || seen.has(file) || !expectedFiles.includes(file) || !Array.isArray(entry.assertionResults)) throw new Error('Unexpected or duplicate test file');
    seen.add(file);
    const cases = entry.assertionResults.map(assertion => {
      if (!['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'].includes(assertion.status) || typeof assertion.fullName !== 'string') throw new Error('Invalid test assertion');
      return { file, name: assertion.fullName, status: assertion.status };
    });
    assertions.push(...cases);
    files.push({ file, status: entry.status === 'passed' && cases.length > 0 && cases.every(test => test.status === 'passed') ? 'passed' : 'failed', tests: cases.length });
  }
  const missingFiles = expectedFiles.filter(file => !seen.has(file));
  const passed = assertions.filter(test => test.status === 'passed').length;
  const failed = assertions.filter(test => test.status === 'failed').length;
  if (assertions.length !== raw.numTotalTests || passed !== raw.numPassedTests || failed !== raw.numFailedTests) throw new Error('Vitest count mismatch');
  return { status: raw.success === true && assertions.length > 0 && missingFiles.length === 0 && files.every(file => file.status === 'passed') ? 'passed' : 'failed', total: assertions.length, passed, failed, skipped: assertions.length - passed - failed, missingFiles, files, assertions };
}
export function summarizeCapabilities(capabilities, suites) {
  if (!Array.isArray(capabilities) || !capabilities.length) throw new Error('Missing capability manifest');
  const states = { unimplemented: 0, partial: 0, conformant: 0, bitexact: 0, 'runtime-blocked': 0 };
  const kinds = {}, ids = new Set(), testFiles = new Map();
  for (const suite of Object.values(suites)) for (const file of suite.files ?? []) testFiles.set(file.file, file.status === 'passed' && suite.status === 'passed');
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
export function summarizeContracts(contracts, suites) {
  const tests = Object.values(suites).flatMap(suite => (suite.assertions ?? []).map(test => ({ ...test, suiteStatus: suite.status })));
  const ids = new Set();
  return contracts.map(contract => {
    if (!contract.id || ids.has(contract.id) || !contract.scope || !Array.isArray(contract.modes)) throw new Error('Invalid or duplicate comparison contract');
    ids.add(contract.id);
    const matches = tests.filter(test => test.file === contract.file && test.name === contract.name);
    const status = matches.length === 1 && matches[0].status === 'passed' && matches[0].suiteStatus === 'passed' ? 'passed' : matches.length === 0 ? 'unverified' : 'failed';
    return { ...contract, status };
  });
}
export function validationStatus(gates, suites, stableSource) {
  return stableSource && gates.length > 0 && gates.every(gate => gate.status === 'passed') && ['unit', 'integration', 'differential', 'workers'].every(name => suites[name]?.status === 'passed') ? 'passed' : 'failed';
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
