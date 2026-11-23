import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpus, platform, arch } from 'node:os';
const root = resolve(import.meta.dirname, '../..');
const lock = JSON.parse(readFileSync(resolve(root, 'compat/upstream.lock.json'), 'utf8'));
const source = resolve(root, 'upstream/ffmpeg');
const run = (file, args, cwd, capture = false) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
const commit = run('git', ['rev-parse', 'HEAD'], source, true).trim();
if (commit !== lock.commit) throw new Error(`Reference commit mismatch: ${commit}`);
if (run('git', ['status', '--porcelain', '--untracked-files=no'], source, true).trim()) throw new Error('Modified reference source');
const build = resolve(root, '.build/reference'); mkdirSync(build, { recursive: true });
const flags = readFileSync(resolve(root, lock.configureFile), 'utf8').trim().split(/\s+/);
run(resolve(source, 'configure'), flags, build);
run('make', [`-j${Math.min(cpus().length, 8)}`], build);
const artifacts = Object.fromEntries(['ffmpeg', 'ffprobe'].map(name => [name, createHash('sha256').update(readFileSync(resolve(build, name))).digest('hex')]));
const metadata = { artifacts, commit, platform: platform(), arch: arch(), flags,
  compiler: run('cc', ['--version'], build, true), version: run('./ffmpeg', ['-version'], build, true),
  targetPlatformMatches: platform() === 'linux' && arch() === 'x64', reproducibleToolchainPinned: false };
writeFileSync(resolve(build, 'build-metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
