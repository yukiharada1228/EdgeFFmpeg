import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotSource, snapshotReference, sha256 } from './source.mjs';
import { renderMarkdown } from './render.mjs';
import { summarizeSuite, summarizeCapabilities, summarizeContracts, validationStatus, summarizeFateExecution, runPlatform, platformPolicy } from './summarize.mjs';
import { readShardDirectory, collectSuite } from './shards.mjs';
import { suiteFiles, fullPlan } from '../ci/plan.mjs';
const root = resolve(import.meta.dirname, '../..');
// --from-shards <dir>: take the four test suites from shard records (tools/ci/shard.mjs) instead of running them here.
// Every other gate still runs here, once. See docs/contributing/ci.md.
const shardOption = process.argv.indexOf('--from-shards');
if (shardOption >= 0 && !process.argv[shardOption + 1]) { console.error('Usage: npm run compat:report [-- --from-shards <dir>]'); process.exit(2); }
const shardDirectory = shardOption >= 0 ? resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[shardOption + 1]) : null;
const startedAt = new Date().toISOString();
const runId = `${startedAt.replaceAll(':', '-')}-${randomUUID()}`;
const directory = resolve(root, '.build/evidence', runId);
mkdirSync(directory, { recursive: true });
mkdirSync(resolve(root, 'compat/reports'), { recursive: true });
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const gates = [], suites = {};
let platform = runPlatform(process, null), execution = { mode: 'serial' };
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
  let shards = null, plan = null, shardsStable = true, shardReferencesStable = true, shardFailure = null;
  if (shardDirectory) {
    plan = fullPlan(before.files.map(entry => entry.file));
    writeFileSync(resolve(directory, 'plan.json'), JSON.stringify(plan, null, 1) + '\n');
    try { shards = readShardDirectory(shardDirectory); } catch (error) { shardFailure = String(error); shards = new Map(); }
    execution = { mode: 'shards', directory: relative(root, shardDirectory) || '.', plan: { sha256: plan.sha256, counts: plan.counts, files: plan.files, estimatedSeconds: plan.estimatedSeconds, file: relative(root, resolve(directory, 'plan.json')) }, records: shards.size, failure: shardFailure };
  }
  for (const [name, script] of Object.entries(scripts)) {
    if (name === 'differential' && extraction.status !== 'passed') { suites[name] = { status: 'not-run', reason: 'Invalid reference provenance', files: [], assertions: [] }; continue; }
    const expected = suiteFiles(before.files.map(entry => entry.file), name);
    if (shards) {
      console.log(`Collecting tests-${name} from ${plan.suites[name].length} shards`);
      const collected = collectSuite(name, shards, { root, directory: shardDirectory, evidence: directory, plan, expected, policy, before, referenceBefore, platform });
      gates.push(collected.gate); console.log(`tests-${name}: ${collected.gate.status}`);
      suites[name] = shardFailure ? { ...collected.suite, status: 'invalid-evidence', reason: shardFailure } : collected.suite;
      shardsStable &&= collected.sourceStable; shardReferencesStable &&= collected.referenceStable;
      continue;
    }
    const file = resolve(directory, `${name}.json`);
    const gate = command(`tests-${name}`, ['run', script, '--', '--reporter=default', '--reporter=json', `--outputFile=${file}`]);
    try {
      const evidence = summarizeSuite(json(file), expected, root, policy);
      suites[name] = { ...evidence, status: gate.status === 'passed' ? evidence.status : 'failed', report: relative(root, file), reportSha256: sha256(readFileSync(file)) };
    } catch (error) { suites[name] = { status: 'invalid-evidence', reason: String(error), files: [], assertions: [] }; }
  }
  const fateGate = extraction.status === 'passed' && inventory.status === 'passed' ? command('fate-execution', ['run', 'fate:run']) : null;
  // From shards, stability also requires every shard to have run on the aggregate's source and reference snapshots.
  const after = snapshotSource(root), sourceStable = before.sha256 === after.sha256 && shardsStable;
  const referenceAfter = referenceBefore ? snapshotReference(root) : null;
  const referenceStable = referenceBefore !== null && JSON.stringify(referenceBefore) === JSON.stringify(referenceAfter) && shardReferencesStable;
  if (shardDirectory) execution = { ...execution, sourceStable: shardsStable, referenceStable: shardReferencesStable };
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
    environment: { node: process.version, platform: process.platform, arch: process.arch }, platform, execution, notApplicable, sourceStable, referenceStable, sourceBefore: before, sourceAfter: after, referenceBefore, referenceAfter,
    reference: manifest?.reference, referenceBinarySha256: manifest?.binarySha256, manifestSha256: manifest ? sha256(readFileSync(resolve(root, 'compat/capabilities.json'))) : null,
    gates, suites, capabilities, contracts,
    scopedBitExactPcmCases: { total: contracts.filter(test => test.modes.includes('bit-exact-pcm')).length, passed: contracts.filter(test => test.modes.includes('bit-exact-pcm') && test.status === 'passed').length, notApplicable: contracts.filter(test => test.modes.includes('bit-exact-pcm') && test.status === 'not-applicable').length, limitation: 'Comparison-contract count, not a feature-level bit-exact compatibility rate' },
    fate: fate ?? null,
    limitations: ['No full conformance certification', 'Reference toolchain is not reproducibly pinned', 'No production Cloudflare run', 'Only five reviewed FATE profiles execute; other definitions remain unported', 'Frame/CPU/resource measurements remain incomplete'] };
  writeReport(report); process.exitCode = developmentValidation === 'passed' ? 0 : 1;
} catch (error) {
  writeReport({ schemaVersion: 2, runId, startedAt, finishedAt: new Date().toISOString(), developmentValidation: 'failed', compatibilityCertified: false, platform, execution, gates, suites, failure: String(error) }); process.exitCode = 1;
}
