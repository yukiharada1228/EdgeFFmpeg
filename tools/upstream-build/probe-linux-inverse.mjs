import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const lock = JSON.parse(readFileSync(resolve(root, 'compat/reference-container.lock.json'), 'utf8'));
const directory = resolve(root, '.build/linux-x64/inverse-probe');
const reference = resolve(root, '.build/linux-x64/reference');
mkdirSync(directory, { recursive: true });
rmSync(resolve(directory, 'report.json'), { force: true });
const metadata = JSON.parse(readFileSync(resolve(reference, 'build-metadata.json'), 'utf8'));
const upstream = JSON.parse(readFileSync(resolve(root, 'compat/upstream.lock.json'), 'utf8'));
const flags = readFileSync(resolve(root, upstream.configureFile), 'utf8').trim().split(/\s+/);
const hash = data => createHash('sha256').update(data).digest('hex');
const referenceHashes = () => Object.fromEntries(['ffmpeg', 'build-metadata.json'].map(name => [name, hash(readFileSync(resolve(reference, name)))]));
const referenceBefore = referenceHashes();
if (metadata.platform !== 'linux' || metadata.arch !== 'x64' || metadata.commit !== upstream.commit || JSON.stringify(metadata.flags) !== JSON.stringify(flags) || hash(readFileSync(resolve(reference, 'ffmpeg'))) !== metadata.artifacts.ffmpeg) throw new Error('Invalid Linux oracle');
const bundled = await build({ stdin: { contents: `export {pixelLayout} from '@edge-ffmpeg/avutil'; export {decodeRawVideo} from '@edge-ffmpeg/avcodec'; export {convertVideoFrame} from '@edge-ffmpeg/swscale';`, resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false });
const { pixelLayout, decodeRawVideo, convertVideoFrame } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const cases = [];
for (const source of ['yuv420p', 'yuva420p', 'yuv422p', 'nv12', 'nv21']) for (const destination of ['rgb24', 'bgr24', 'rgba', 'bgra', 'argb', 'abgr', 'gbrp']) for (const [width, height] of [[1,1],[2,2],[3,2],[3,3],[5,3],[6,4],[8,6],[16,6],[17,9],[32,8],[33,32],[127,65],[5,7],[16,7],[16,5],[6,7]]) {
  const id = `${source}-${destination}-${width}x${height}`;
  let seed = 53;
  const data = Uint8Array.from({ length: pixelLayout(source, width, height).bytes }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; });
  writeFileSync(resolve(directory, `${id}.input`), data);
  const frame = decodeRawVideo({ streamIndex: 0, data, pts: 0n, dts: null, duration: 1n, timeBase: { num: 1n, den: 25n }, flags: 1 }, { pixelFormat: source, width, height }, { maxFrameBytes: 65536 });
  const outputs = {};
  for (const arithmetic of ['aarch64', 'scalar', 'x86_64']) {
    try { outputs[arithmetic] = { sha256: hash(Buffer.concat(convertVideoFrame(frame, destination, { arithmetic, maxFrameBytes: 65536, maxStateBytes: 65536 }).planes)) }; }
    catch (error) { outputs[arithmetic] = { rejected: String(error) }; }
  }
  cases.push({ id, source, destination, width, height, inputSha256: hash(data), outputs });
}
writeFileSync(resolve(directory, 'cases.json'), JSON.stringify(cases));
const program = `
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
const cases = JSON.parse(fs.readFileSync('/probe/cases.json'));
for (const item of cases) {
  item.native = {};
  for (const profile of ['default', 'scalar']) {
    const repetitions = profile === 'default' && ['nv12', 'nv21'].includes(item.source) && item.destination === 'rgb24' && item.height % 2 === 0 ? 8 : 1;
    const hashes = {};
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const output = cp.execFileSync('/reference/ffmpeg', ['-v', 'error', ...(profile === 'scalar' ? ['-cpuflags', '0'] : []), '-f', 'rawvideo', '-pixel_format', item.source, '-video_size', item.width + 'x' + item.height, '-i', '/probe/' + item.id + '.input', '-frames:v', '1', '-pix_fmt', item.destination, '-f', 'rawvideo', '-'], {timeout: 30000});
      const digest = crypto.createHash('sha256').update(output).digest('hex');
      hashes[digest] = (hashes[digest] ?? 0) + 1;
      if (repeat === 0) item.native[profile] = digest;
    }
    item.native[profile + 'Observations'] = hashes;
  }
}
console.log(JSON.stringify(cases));`;
const observations = JSON.parse(execFileSync('docker', ['run', '--rm', '--platform', lock.platform, '--network', 'none', '--mount', `type=bind,src=${reference},dst=/reference,readonly`, '--mount', `type=bind,src=${directory},dst=/probe,readonly`, lock.image, 'node', '-e', program], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const referenceAfter = referenceHashes();
if (JSON.stringify(referenceBefore) !== JSON.stringify(referenceAfter)) throw new Error('Linux oracle changed during diagnostic');
const summary = { cases: observations.length, explicitScalarMatches: observations.filter(item => item.outputs.scalar.sha256 === item.native.scalar).length, defaultMatchesScalar: observations.filter(item => item.outputs.scalar.sha256 === item.native.default).length, defaultMatchesAarch64: observations.filter(item => item.outputs.aarch64.sha256 === item.native.default).length, defaultMatchesX86: observations.filter(item => item.outputs.x86_64.sha256 === item.native.default).length, aarch64Rejected: observations.filter(item => item.outputs.aarch64.rejected).length, repeatedDefaultCases: observations.filter(item => Object.values(item.native.defaultObservations).reduce((a,b) => a+b, 0) > 1).length, observedUnstableCases: observations.filter(item => Object.keys(item.native.defaultObservations).length > 1).length };
writeFileSync(resolve(directory, 'report.json'), JSON.stringify({ diagnosticOnly: true, generatedAt: new Date().toISOString(), reference: metadata, referenceBefore, referenceAfter, referenceStable: true, image: lock.image, sourceBundleSha256: hash(bundled.outputFiles[0].text), summary, observations }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
