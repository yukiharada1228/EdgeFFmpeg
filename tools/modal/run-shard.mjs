import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { platform, arch } from 'node:os';
import { pathToFileURL } from 'node:url';

export function sourceDigest(files) {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function safePath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error(`Invalid repository path: ${path}`);
  const full = resolve(root, path);
  if (relative(root, full).startsWith('..')) throw new Error(`Path escapes repository: ${path}`);
  return full;
}
async function checkedFile(root, path) {
  const full = safePath(root, path);
  const actual = await realpath(full).catch(() => { throw new Error(`Required file missing: ${path}`); });
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Symlink escapes repository: ${path}`);
  return readFile(actual);
}
export async function validateInputs(root, manifest, shard) {
  root = await realpath(root);
  if (manifest.schemaVersion !== 1 || !['portable-unit-v1', 'flac-unit-v1'].includes(manifest.suite) || !manifest.source) throw new Error('Unsupported manifest/shard schemaVersion');
  if (!Array.isArray(manifest.source.files) || manifest.source.files.length === 0) throw new Error('Manifest must contain source files');
  const paths = new Set();
  for (const file of manifest.source.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid SHA256: ${file.path}`);
    if (paths.has(file.path)) throw new Error(`Duplicate source path: ${file.path}`);
    paths.add(file.path);
    const bytes = await checkedFile(root, file.path);
    if (bytes.length !== file.bytes) throw new Error(`Source byte length mismatch: ${file.path}`);
    if (sha256(bytes) !== file.sha256) throw new Error(`Source hash mismatch: ${file.path}`);
  }
  if (sourceDigest(manifest.source.files) !== manifest.source.sha256) throw new Error('Manifest sourceHash mismatch');
  if (!((typeof shard.id === 'string' && shard.id.length > 0) || (Number.isInteger(shard.id) && shard.id >= 0)) || !Array.isArray(shard.testFiles) || shard.testFiles.length === 0) throw new Error('Shard needs id and explicit test files');
  if (new Set(shard.testFiles).size !== shard.testFiles.length) throw new Error('Duplicate shard test file');
  for (const file of shard.testFiles) {
    safePath(root, file);
    if (!paths.has(file) || !/^tests\/.+\.test\.[cm]?[jt]sx?$/.test(file)) throw new Error(`Test is not in source manifest: ${file}`);
  }
  for (const artifact of manifest.requiredArtifacts ?? []) {
    const bytes = await checkedFile(root, artifact.path);
    if (artifact.sha256 && sha256(bytes) !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${artifact.path}`);
  }
  if (shard.timeoutSeconds !== undefined && (!Number.isInteger(shard.timeoutSeconds) || shard.timeoutSeconds < 1 || shard.timeoutSeconds > 840)) throw new Error('Invalid shard timeoutSeconds');
}
function execute(command, args, cwd, timeoutMs) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd, shell: false, env: { ...process.env, CI: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, spawnError;
    const append = (old, bytes) => (old + bytes.toString()).slice(-32768);
    child.stdout.on('data', b => { stdout = append(stdout, b); });
    child.stderr.on('data', b => { stderr = append(stderr, b); });
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } };
    let escalation;
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 5000); }, timeoutMs);
    child.on('error', error => { spawnError = error.message; });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); clearTimeout(escalation); resolveResult({ exitCode, signal, timedOut, spawnError, stdout, stderr }); });
  });
}
export function assertionRecords(reports, root) {
  return reports.flatMap(suite => {
    const file = relative(root, suite.name);
    return (suite.assertionResults ?? []).map(test => ({
      id: `${file}::${test.fullName}`, file, name: test.fullName,
      status: test.status, durationMs: test.duration ?? null,
    }));
  });
}
export function reportDiagnostics(report, root, requestedFiles) {
  const reports = report.testResults ?? [];
  const actualFiles = new Set(reports.map(suite => relative(root, suite.name)));
  const bounded = value => {
    if (value === undefined || value === null) return null;
    return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 16000);
  };
  return {
    missingTestFiles: requestedFiles.filter(file => !actualFiles.has(file)),
    suiteFailures: reports.filter(suite => suite.status === 'failed' || suite.message).map(suite => ({
      file: relative(root, suite.name), status: suite.status,
      message: bounded(suite.message),
      assertionCount: suite.assertionResults?.length ?? 0,
      failureMessage: bounded(suite.failureMessage),
    })),
    unhandledErrors: (Array.isArray(report.unhandledErrors) ? report.unhandledErrors : report.unhandledErrors ? [report.unhandledErrors] : []).map(bounded),
    reportErrors: bounded(report.errors),
    reportSuccess: report.success,
  };
}
export async function packageVersions(root) {
  root = await realpath(root);
  const versions = {};
  for (const name of ['vitest', 'typescript', 'esbuild']) {
    const metadata = JSON.parse(await checkedFile(root, `node_modules/${name}/package.json`));
    if (typeof metadata.version !== 'string' || !metadata.version) throw new Error(`Missing installed version: ${name}`);
    versions[name] = metadata.version;
  }
  return versions;
}
export async function runShard({ root, manifestPath, shardPath, outputPath }) {
  const started = Date.now();
  const result = { schemaVersion: 1, platform: platform(), arch: arch(), node: process.version, sourceHash: null, shardId: null, status: 'failed', durationMs: 0, tests: null };
  try {
    root = await realpath(root);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const shard = manifest.shards?.find(item => String(item.id) === String(shardPath));
    if (!shard) throw new Error(`Unknown shard: ${shardPath}`);
    result.sourceHash = manifest.source.sha256;
    result.shardId = shard.id;
    if (platform() !== 'linux') throw new Error('Remote shard runner requires Linux; local validation is available via validateInputs');
    await validateInputs(root, manifest, shard);
    result.packageVersions = await packageVersions(root);
    result.suite = manifest.suite;
    await mkdir(dirname(outputPath), { recursive: true });
    const reportPath = `${outputPath}.vitest.json`;
    await rm(reportPath, { force: true });
    const cli = safePath(root, 'node_modules/vitest/vitest.mjs');
    await checkedFile(root, 'node_modules/vitest/vitest.mjs');
    const execution = await execute(process.execPath, [cli, 'run', ...shard.testFiles, '--maxWorkers=1', '--reporter=json', `--outputFile=${reportPath}`, '--passWithNoTests=false'], root, (shard.timeoutSeconds ?? 780) * 1000);
    result.execution = execution;
    let report;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch { throw new Error('Vitest did not produce a valid JSON report'); }
    result.tests = { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests, todo: report.numTodoTests ?? 0, suites: report.numTotalTestSuites };
    const reports = report.testResults ?? [];
    result.assertions = assertionRecords(reports, root);
    Object.assign(result, reportDiagnostics(report, root, shard.testFiles));
    const allFiles = result.missingTestFiles.length === 0;
    result.failures = reports.flatMap(suite => (suite.assertionResults ?? []).filter(test => test.status === 'failed').map(test => ({ name: test.fullName, messages: (test.failureMessages ?? []).map(m => m.slice(0, 4000)) }))).slice(0, 100);
    await validateInputs(root, manifest, shard);
    if (!allFiles) throw new Error(`Vitest report omitted requested test files: ${result.missingTestFiles.join(', ')}`);
    if (execution.exitCode === 0 && !execution.timedOut && report.success === true && result.tests.total > 0 && result.tests.failed === 0 && result.tests.pending === 0 && result.tests.todo === 0) result.status = 'passed';
  } catch (error) { result.error = error.message; }
  result.durationMs = Date.now() - started;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--root', '--manifest', '--shard', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: run-shard.mjs --manifest PATH --shard ID --output PATH [--root PATH]');
    options[args[i]] = args[i + 1];
  }
  for (const key of ['--manifest', '--shard', '--output']) if (!options[key]) throw new Error(`Missing ${key}`);
  const result = await runShard({ root: resolve(options['--root'] ?? '.'), manifestPath: resolve(options['--manifest']), shardPath: options['--shard'], outputPath: resolve(options['--output']) });
  process.stdout.write(JSON.stringify({ status: result.status, shardId: result.shardId, tests: result.tests, error: result.error }) + '\n');
  if (result.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
