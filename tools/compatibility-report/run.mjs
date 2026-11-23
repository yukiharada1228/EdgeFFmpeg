import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotSource, snapshotReference, sha256 } from './source.mjs';
import { summarizeSuite, summarizeCapabilities, summarizeContracts, validationStatus, summarizeFateExecution } from './summarize.mjs';
const root = resolve(import.meta.dirname, '../..');
const startedAt = new Date().toISOString();
const runId = `${startedAt.replaceAll(':', '-')}-${randomUUID()}`;
const directory = resolve(root, '.build/evidence', runId);
mkdirSync(directory, { recursive: true });
mkdirSync(resolve(root, 'compat/reports'), { recursive: true });
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const gates = [], suites = {};
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
  const lines = [
    '# EdgeFFmpeg development compatibility evidence', '',
    `Generated: ${report.finishedAt}`, `Run: ${runId}`, '',
    `Development validation: **${report.developmentValidation}**`,
    '**Full FFmpeg compatibility is not certified.**', '',
    `Source snapshot stable: ${report.sourceStable ?? false}`, `Reference artifacts stable: ${report.referenceStable ?? false}`, '',
    '| Suite | Result | Passed | Failed | Skipped | Total |', '|---|---|---:|---:|---:|---:|'
  ];
  for (const [name, suite] of Object.entries(report.suites ?? {})) lines.push(`| ${name} | ${suite.status} | ${suite.passed ?? 0} | ${suite.failed ?? 0} | ${suite.skipped ?? 0} | ${suite.total ?? 0} |`);
  if (report.capabilities) lines.push('', `Capability entries: ${report.capabilities.total}`, `Implementation states: ${JSON.stringify(report.capabilities.states)}`, `Unverified full conformance: ${report.capabilities.unverifiedConformance}`, '', 'Capability entries include codec families as well as separate encoder/decoder entries; they are not independent end-user features.');
  if (report.capabilities?.knownDifferences.length) {
    lines.push('', '## Known differences', '');
    for (const difference of report.capabilities.knownDifferences) lines.push(`- ${difference.features.join(', ')}: ${difference.notes}`);
  }
  lines.push('', '## Scoped native comparisons', '', '| Contract | Result | Modes | Scope |', '|---|---|---|---|');
  for (const contract of report.contracts ?? []) lines.push(`| ${contract.id} | ${contract.status} | ${contract.modes.join(', ')} | ${contract.scope.replaceAll('|', '\\|')} |`);
  lines.push('', 'Bit-exact PCM comparisons cover only their named payload fixtures. They do not establish WAV file byte identity or full codec compatibility.', '', '## Required gates', '');
  for (const gate of gates) lines.push(`- ${gate.name}: ${gate.status} (exit ${gate.exitCode})`);
  if (report.reference) lines.push('', `Canonical target platform: ${report.reference.targetPlatformMatches}`, `Reproducible toolchain pinned: ${report.reference.reproducibleToolchainPinned}`, '', 'Native tests use the recorded local oracle. Local workerd tests are not production Cloudflare verification.');
  if (report.fate) lines.push('', `FATE explicit command definitions: ${report.fate.explicitCommandDefinitions}; executed with reviewed adaptations: ${report.fate.executedDefinitions}; unexecuted: ${report.fate.unexecutedDefinitions}. Generated Make targets are not included.`);
  if (report.failure) lines.push('', `Report failure: ${report.failure}`);
  lines.push('', 'See current.json and the run evidence directory for source/artifact hashes, test assertions and known differences.');
  const markdown = lines.join('\n') + '\n';
  writeFileSync(resolve(directory, 'report.md'), markdown); writeFileSync(resolve(root, 'compat/reports/current.md'), markdown);
  console.log(`Report: ${relative(root, directory)}/report.md`);
}
try {
  const extraction = command('reference-extract', ['run', 'reference:extract']);
  const inventory = command('fate-inventory', ['run', 'fate:inventory']);
  command('fate-audio-audit', ['run', 'fate:audit']);
  const before = snapshotSource(root);
  const referenceBefore = extraction.status === 'passed' ? snapshotReference(root) : null;
  command('typecheck', ['run', 'typecheck']); command('declarations', ['run', 'types:declarations']); command('lint', ['run', 'lint']); command('boundaries', ['run', 'boundaries']);
  command('worker-types', ['run', 'workers:types', '--', '--check']); command('worker-bundle', ['run', 'workers:bundle']);
  const scripts = { unit: 'test', integration: 'test:integration', differential: 'test:differential', workers: 'test:workers' };
  for (const [name, script] of Object.entries(scripts)) {
    if (name === 'differential' && extraction.status !== 'passed') { suites[name] = { status: 'not-run', reason: 'Invalid reference provenance', files: [], assertions: [] }; continue; }
    const file = resolve(directory, `${name}.json`);
    const gate = command(`tests-${name}`, ['run', script, '--', '--reporter=default', '--reporter=json', `--outputFile=${file}`]);
    try {
      const expected = before.files.map(entry => entry.file).filter(file => file.startsWith(`tests/${name}/`) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
      const evidence = summarizeSuite(json(file), expected, root);
      suites[name] = { ...evidence, status: gate.status === 'passed' ? evidence.status : 'failed', report: relative(root, file), reportSha256: sha256(readFileSync(file)) };
    } catch (error) { suites[name] = { status: 'invalid-evidence', reason: String(error), files: [], assertions: [] }; }
  }
  const fateGate = extraction.status === 'passed' && inventory.status === 'passed' ? command('fate-execution', ['run', 'fate:run']) : null;
  const after = snapshotSource(root), sourceStable = before.sha256 === after.sha256;
  const referenceAfter = referenceBefore ? snapshotReference(root) : null;
  const referenceStable = referenceBefore !== null && JSON.stringify(referenceBefore) === JSON.stringify(referenceAfter);
  const manifest = extraction.status === 'passed' ? json('compat/capabilities.json') : undefined;
  const capabilities = manifest ? summarizeCapabilities(manifest.capabilities, suites) : undefined;
  const contracts = summarizeContracts(json('compat/test-contracts.json'), suites);
  let fate;
  if (fateGate?.status === 'passed') {
    const profiles = json('compat/fate/profiles.json').map(path=>({...json(path),sha256:sha256(readFileSync(resolve(root,path)))}));
    const execution = json('compat/reports/fate-execution.json');
    fate = {...summarizeFateExecution(execution,json('compat/reports/fate-inventory.json'),profiles,before.sha256,referenceBefore),report:'compat/reports/fate-execution.json',reportSha256:sha256(readFileSync(resolve(root,'compat/reports/fate-execution.json')))};
  }
  const developmentValidation = validationStatus(gates, suites, sourceStable && referenceStable) === 'passed' && contracts.every(contract => contract.status === 'passed') && fate?.status === 'passed' ? 'passed' : 'failed';
  const report = { schemaVersion: 1, runId, startedAt, finishedAt: new Date().toISOString(), developmentValidation, compatibilityCertified: false,
    environment: { node: process.version, platform: process.platform, arch: process.arch }, sourceStable, referenceStable, sourceBefore: before, sourceAfter: after, referenceBefore, referenceAfter,
    reference: manifest?.reference, referenceBinarySha256: manifest?.binarySha256, manifestSha256: manifest ? sha256(readFileSync(resolve(root, 'compat/capabilities.json'))) : null,
    gates, suites, capabilities, contracts,
    scopedBitExactPcmCases: { total: contracts.filter(test => test.modes.includes('bit-exact-pcm')).length, passed: contracts.filter(test => test.modes.includes('bit-exact-pcm') && test.status === 'passed').length, limitation: 'Comparison-contract count, not a feature-level bit-exact compatibility rate' },
    fate: fate ?? null,
    limitations: ['No full conformance certification', 'Reference toolchain is not reproducibly pinned', 'No production Cloudflare run', 'Only five reviewed FATE profiles execute; other definitions remain unported', 'Frame/CPU/resource measurements remain incomplete'] };
  writeReport(report); process.exitCode = developmentValidation === 'passed' ? 0 : 1;
} catch (error) {
  writeReport({ schemaVersion: 1, runId, startedAt, finishedAt: new Date().toISOString(), developmentValidation: 'failed', compatibilityCertified: false, gates, suites, failure: String(error) }); process.exitCode = 1;
}
