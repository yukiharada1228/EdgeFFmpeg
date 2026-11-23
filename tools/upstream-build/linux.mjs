import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const lock = JSON.parse(readFileSync(resolve(root, 'compat/reference-container.lock.json'), 'utf8'));
if (!/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/.test(lock.image) || lock.platform !== 'linux/amd64' || lock.outputDirectory !== '.build/linux-x64') {
  throw new Error('Invalid reference container lock');
}
const output = resolve(root, lock.outputDirectory);
mkdirSync(output, { recursive: true });
rmSync(resolve(output, 'container-run.json'), { force: true });
// Only the isolated build directory is writable. The host reference stays intact.
const args = ['run', '--rm', '--platform', lock.platform, '--network', 'none',
  '--mount', `type=bind,src=${root},dst=/workspace,readonly`,
  '--mount', `type=bind,src=${output},dst=/workspace/.build`,
  '-w', '/workspace', lock.image, 'sh', '-c',
  'git config --global --add safe.directory /workspace/upstream/ffmpeg && node tools/upstream-build/build.mjs'];
const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Linux reference container failed: ${result.signal ?? result.status}`);
const metadata = JSON.parse(readFileSync(resolve(output, 'reference/build-metadata.json'), 'utf8'));
if (metadata.platform !== 'linux' || metadata.arch !== 'x64' || !metadata.targetPlatformMatches) throw new Error('Reference container did not build the requested target');
writeFileSync(resolve(output, 'container-run.json'), JSON.stringify({ image: lock.image, platform: lock.platform, artifacts: metadata.artifacts, completedAt: new Date().toISOString(), reproducibleBinaryVerified: false }, null, 2) + '\n');
