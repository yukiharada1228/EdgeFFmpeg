import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, mkdir, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, NodeInputChangedError } from '@edge-ffmpeg/runtime-node';
import { openWav, muxWav } from '@edge-ffmpeg/containers';
import { chunk, riff, pcmFormat } from '../helpers/wav.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(overwrite = false) {
  const root = await mkdtemp(join(tmpdir(), 'edgeffmpeg-node-')); roots.push(root);
  const fs = await createNodeFileSystem({ root, maxReadBytes: 8, maxWriteBytes: 8, overwrite });
  return { root, fs };
}
it('hides staged output until commit and makes commit/abort idempotent', async () => {
  const { root, fs } = await fixture(); const output = await fs.openWrite('/result');
  await output.write(new Uint8Array([1,2,3]));
  await expect(readFile(join(root, 'result'))).rejects.toMatchObject({ code: 'ENOENT' });
  await output.commit(); await output.commit(); await output.abort();
  expect([...await readFile(join(root, 'result'))]).toEqual([1,2,3]);
  expect(await readdir(root)).toEqual(['result']);
  await expect(output.write(new Uint8Array([4]))).rejects.toThrow('committed');
});
it('aborts without publishing and enforces I/O bounds', async () => {
  const { root, fs } = await fixture(); const output = await fs.openWrite('/result');
  await expect(output.write(new Uint8Array(9))).rejects.toThrow('budget');
  await output.abort(); await output.abort(); expect(await readdir(root)).toEqual([]);
  await writeFile(join(root, 'input'), new Uint8Array([1,2,3]));
  const input = await fs.openRead('/input');
  expect([...await input.readAt(2n, 8)]).toEqual([3]); expect((await input.readAt(4n, 1)).length).toBe(0);
  await expect(input.readAt(-1n, 1)).rejects.toThrow('range'); await expect(input.readAt(0n, 9)).rejects.toThrow('range');
  const abort = new AbortController(); abort.abort('stop'); await expect(input.readAt(0n, 1, abort.signal)).rejects.toBe('stop');
});
it('never clobbers an existing output by default, including a commit race', async () => {
  const { root, fs } = await fixture();
  const a = await fs.openWrite('/result'), b = await fs.openWrite('/result');
  await a.write(new Uint8Array([1])); await b.write(new Uint8Array([2]));
  await a.commit(); await expect(b.commit()).rejects.toMatchObject({ code: 'EEXIST' }); await b.abort();
  expect([...await readFile(join(root, 'result'))]).toEqual([1]); expect(await readdir(root)).toEqual(['result']);
});
it('allows explicit replacement while preserving the old output before commit', async () => {
  const { root, fs } = await fixture(true); await writeFile(join(root, 'result'), 'old');
  const output = await fs.openWrite('/result'); await output.write(new TextEncoder().encode('new'));
  expect(await readFile(join(root, 'result'), 'utf8')).toBe('old'); await output.commit();
  expect(await readFile(join(root, 'result'), 'utf8')).toBe('new'); expect(await readdir(root)).toEqual(['result']);
});
it('detects input replacement even when its bytes are identical', async () => {
  const { root, fs } = await fixture(); await writeFile(join(root, 'input'), 'abc');
  const input = await fs.openRead('/input'); await writeFile(join(root, 'replacement'), 'abc'); await rename(join(root, 'replacement'), join(root, 'input'));
  await expect(input.readAt(0n, 3)).rejects.toBeInstanceOf(NodeInputChangedError);
});
it('rejects traversal and symlink escapes from the configured root', async () => {
  const { root, fs } = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'edgeffmpeg-outside-')); roots.push(outside);
  await writeFile(join(outside, 'secret'), 'secret'); await symlink(outside, join(root, 'escape'));
  for (const path of ['/../secret', '/escape/secret']) {
    await expect(fs.openRead(path)).rejects.toThrow(); await expect(fs.openWrite(path)).rejects.toThrow();
  }
  await mkdir(join(root, 'sub')); const output = await fs.openWrite('/sub/result'); await output.abort();
});
it('stream-copies a WAV through real files and leaves no output on validation failure', async () => {
  const { root, fs } = await fixture();
  const original = riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array([1,0,2,0,3,0]))]);
  await writeFile(join(root, 'input.wav'), original);
  const input = await openWav(await fs.openRead('/input.wav'), { maxReadBytes: 8 });
  await muxWav(await fs.openWrite('/output.wav'), { codec: 'pcm_s16le', channels: 1, sampleRate: 8000 }, input.packets(), { sampleCount: 3n, maxWriteBytes: 8 });
  expect(new Uint8Array(await readFile(join(root, 'output.wav')))).toEqual(original);
  await expect(muxWav(await fs.openWrite('/failed.wav'), { codec: 'pcm_s16le', channels: 1, sampleRate: 8000 }, input.packets(), { sampleCount: 4n, maxWriteBytes: 8 })).rejects.toThrow('declared duration');
  expect((await readdir(root)).sort()).toEqual(['input.wav', 'output.wav']);
});
