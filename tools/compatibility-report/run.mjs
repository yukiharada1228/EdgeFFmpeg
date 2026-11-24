import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotSource, snapshotReference, sha256 } from './source.mjs';
import { renderMarkdown } from './render.mjs';
import { summarizeSuite, summarizeCapabilities, summarizeContracts, validationStatus, summarizeFateExecution, runPlatform, platformPolicy } from './summarize.mjs';
const root = resolve(import.meta.dirname, '../..');
const startedAt = new Date().toISOString();
const runId = `${startedAt.replaceAll(':', '-')}-${randomUUID()}`;
const directory = resolve(root, '.build/evidence', runId);
mkdirSync(directory, { recursive: true });
mkdirSync(resolve(root, 'compat/reports'), { recursive: true });
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const gates = [], suites = {};
let platform = runPlatform(process, null);
function command(name, args) {
  console.log(`Running ${name}`);
  const start = Date.now();
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? '\n' + result.error.message : ''}`;
  const file = resolve(directory, `${name}.log`); writeFileSync(file, log);
  const gate = { name, command: ['npm', ...args], status: result.status === 0 && !result.error ? 'passed' : 'failed', exitCode: result.status, signal: result.signal, durationMs: Date.now() - start, log: relative(root, file), logSha256: sha256(log) };
  gates.push(gate); console.log(`${name}: ${gate.status}`); return gate;
}
function writeReport(report) {
  const serialized = JSON.stringify(report, null, 2) + '\n';
  for (const path of [resolve(directory, 'report.json'), resolve(root, 'compat/reports/current.json')]) writeFileSync(path, serialized);
  const markdown = renderMarkdown(report);
  writeFileSync(resolve(directory, 'report.md'), markdown); writeFileSync(resolve(root, 'compat/reports/current.md'), markdown);
  console.log(`Report: ${relative(root, directory)}/report.md`);
}
try {
  const extraction = command('reference-extract', ['run', 'reference:extract']);
  const inventory = command('fate-inventory', ['run', 'fate:inventory']);
  command('fate-audio-audit', ['run', 'fate:audit']);
  const before = snapshotSource(root);
  const referenceBefore = extraction.status === 'passed' ? snapshotReference(root) : null;
  platform = runPlatform(process, extraction.status === 'passed' ? json('.build/reference/build-metadata.json') : null);
  let contractList, policy;
  // An unreadable or invalid contract list leaves every skip unexpected; summarizeContracts rejects it after the gates have run, as before.
  try { contractList = json('compat/test-contracts.json'); policy = platformPolicy(contractList, platform); } catch { policy = undefined; }
  command('typecheck', ['run', 'typecheck']); command('declarations', ['run', 'types:declarations']); command('lint', ['run', 'lint']); command('boundaries', ['run', 'boundaries']);
  command('worker-types', ['run', 'workers:types', '--', '--check']); command('worker-bundle', ['run', 'workers:bundle']);
  const scripts = { unit: 'test', integration: 'test:integration', differential: 'test:differential', workers: 'test:workers' };
  for (const [name, script] of Object.entries(scripts)) {
    if (name === 'differential' && extraction.status !== 'passed') { suites[name] = { status: 'not-run', reason: 'Invalid reference provenance', files: [], assertions: [] }; continue; }
    const file = resolve(directory, `${name}.json`);
    const gate = command(`tests-${name}`, ['run', script, '--', '--reporter=default', '--reporter=json', `--outputFile=${file}`]);
    try {
      const expected = before.files.map(entry => entry.file).filter(file => file.startsWith(`tests/${name}/`) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
      const evidence = summarizeSuite(json(file), expected, root, policy);
      suites[name] = { ...evidence, status: gate.status === 'passed' ? evidence.status : 'failed', report: relative(root, file), reportSha256: sha256(readFileSync(file)) };
    } catch (error) { suites[name] = { status: 'invalid-evidence', reason: String(error), files: [], assertions: [] }; }
  }
  const fateGate = extraction.status === 'passed' && inventory.status === 'passed' ? command('fate-execution', ['run', 'fate:run']) : null;
  const after = snapshotSource(root), sourceStable = before.sha256 === after.sha256;
  const referenceAfter = referenceBefore ? snapshotReference(root) : null;
  const referenceStable = referenceBefore !== null && JSON.stringify(referenceBefore) === JSON.stringify(referenceAfter);
  const manifest = extraction.status === 'passed' ? json('compat/capabilities.json') : undefined;
  const capabilities = manifest ? summarizeCapabilities(manifest.capabilities, suites) : undefined;
  const contracts = summarizeContracts(contractList ?? json('compat/test-contracts.json'), suites, platform);
  const notApplicableContracts = contracts.filter(contract => contract.status === 'not-applicable');
  const notApplicable = { platform: platform.host, contracts: notApplicableContracts.length, ids: notApplicableContracts.map(contract => contract.id),
    requiredPlatforms: [...new Set(notApplicableContracts.flatMap(contract => contract.platforms))].sort(),
    tests: Object.values(suites).reduce((total, suite) => total + (suite.notApplicable ?? 0), 0),
    limitation: 'Platform-gated skips are not evidence of passing. These contracts resolve only on a run on a listed platform.' };
  let fate;
  if (fateGate?.status === 'passed') {
    const profiles = json('compat/fate/profiles.json').map(path=>({...json(path),sha256:sha256(readFileSync(resolve(root,path)))}));
    const execution = json('compat/reports/fate-execution.json');
    fate = {...summarizeFateExecution(execution,json('compat/reports/fate-inventory.json'),profiles,before.sha256,referenceBefore),report:'compat/reports/fate-execution.json',reportSha256:sha256(readFileSync(resolve(root,'compat/reports/fate-execution.json')))};
  }
  const developmentValidation = validationStatus(gates, suites, sourceStable && referenceStable) === 'passed' && contracts.every(contract => contract.status === 'passed' || contract.status === 'not-applicable') && fate?.status === 'passed' ? 'passed' : 'failed';
  const report = { schemaVersion: 2, runId, startedAt, finishedAt: new Date().toISOString(), developmentValidation, compatibilityCertified: false,
    environment: { node: process.version, platform: process.platform, arch: process.arch }, platform, notApplicable, sourceStable, referenceStable, sourceBefore: before, sourceAfter: after, referenceBefore, referenceAfter,
    reference: manifest?.reference, referenceBinarySha256: manifest?.binarySha256, manifestSha256: manifest ? sha256(readFileSync(resolve(root, 'compat/capabilities.json'))) : null,
    gates, suites, capabilities, contracts,
    scopedBitExactPcmCases: { total: contracts.filter(test => test.modes.includes('bit-exact-pcm')).length, passed: contracts.filter(test => test.modes.includes('bit-exact-pcm') && test.status === 'passed').length, notApplicable: contracts.filter(test => test.modes.includes('bit-exact-pcm') && test.status === 'not-applicable').length, limitation: 'Comparison-contract count, not a feature-level bit-exact compatibility rate' },
    fate: fate ?? null,
    limitations: ['No full conformance certification', 'Reference toolchain is not reproducibly pinned', 'No production Cloudflare run', 'Only five reviewed FATE profiles execute; other definitions remain unported', 'Frame/CPU/resource measurements remain incomplete'] };
  writeReport(report); process.exitCode = developmentValidation === 'passed' ? 0 : 1;
} catch (error) {
  writeReport({ schemaVersion: 2, runId, startedAt, finishedAt: new Date().toISOString(), developmentValidation: 'failed', compatibilityCertified: false, platform, gates, suites, failure: String(error) }); process.exitCode = 1;
}
