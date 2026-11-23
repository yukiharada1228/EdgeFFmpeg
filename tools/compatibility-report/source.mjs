import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function snapshotSource(root) {
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const entries = [];
  for (const file of files) {
    const path = resolve(root, file), stat = lstatSync(path);
    if (stat.isFile() || stat.isSymbolicLink()) entries.push({ file, sha256: sha256(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)) });
  }
  const upstream = resolve(root, 'upstream/ffmpeg');
  const content = { revision: git(['rev-parse', 'HEAD']), upstreamCommit: git(['rev-parse', 'HEAD'], upstream), upstreamChanges: git(['status', '--porcelain', '--untracked-files=no'], upstream), files: entries };
  return { ...content, sha256: sha256(JSON.stringify(content)), worktreeStatus: git(['status', '--short']) };
}
export function snapshotReference(root) {
  return Object.fromEntries(['ffmpeg', 'ffprobe', 'build-metadata.json'].map(name => [name, sha256(readFileSync(resolve(root, '.build/reference', name)))]));
}
