import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { decodePcm, encodePcm } from '@edge-ffmpeg/avcodec';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
it('matches all 16 integer PCM depth conversions against native FFmpeg and runs the CLI path', async () => {
  const metadata = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8')) as { commit: string };
  const lock = JSON.parse(readFileSync('compat/upstream.lock.json', 'utf8')) as { commit: string }; expect(metadata.commit).toBe(lock.commit);
  const root = mkdtempSync(join(tmpdir(), 'edgeffmpeg-pcm-'));
  const codecs = ['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le'] as const;
  try {
    const fs = await createNodeFileSystem({ root, maxReadBytes: 1024, maxWriteBytes: 1024 });
    const ffmpeg = new FFmpeg({ filesystem: fs, backend: createWavBackend(), budget: { maxResidentBytes: 65536, maxBufferBytes: 1024, maxPendingPackets: 2, maxCpuTimeMs: 1000 } });
    for (const source of codecs) {
      const bytesPerSample = source === 'pcm_u8' ? 1 : source === 'pcm_s16le' ? 2 : source === 'pcm_s24le' ? 3 : 4;
      const bytes = Uint8Array.from({ length: 256 * bytesPerSample }, (_, i) => (i * 73 + 37) & 255);
      bytes.fill(0, 0, bytesPerSample); bytes.fill(255, bytesPerSample, bytesPerSample * 2);
      const input = join(root, `${source}.raw`); writeFileSync(input, bytes);
      const format = source === 'pcm_u8' ? 'u8' : source.slice(4);
      execFileSync(resolve('.build/reference/ffmpeg'), ['-v','error','-f',format,'-ar','8000','-ac','2','-i',input,'-c:a','copy',join(root,`${source}.wav`)], { timeout: 30000 });
      const frame = decodePcm({ streamIndex: 0, data: bytes, pts: 0n, dts: 0n, duration: 128n, timeBase: { num: 1n, den: 8000n }, flags: 1 }, { codec: source, channels: 2, sampleRate: 8000 }, { maxFrameBytes: 4096 });
      for (const target of codecs) {
        const raw = target === 'pcm_u8' ? 'u8' : target.slice(4);
        const native = execFileSync(resolve('.build/reference/ffmpeg'), ['-v','error','-f',format,'-ar','8000','-ac','2','-i',input,'-c:a',target,'-f',raw,'-'], { timeout: 30000 });
        expect(Buffer.from(encodePcm(frame, target, { maxFrameBytes: 4096 }).data)).toEqual(native);
        const result = await ffmpeg.exec(['-i',`/${source}.wav`,'-c:a',target,`/${source}-${target}.wav`]);
        expect(result.exitCode, JSON.stringify(result.diagnostics)).toBe(0);
        const actual = execFileSync(resolve('.build/reference/ffmpeg'), ['-v','error','-i',join(root,`${source}-${target}.wav`),'-c:a','copy','-f',raw,'-'], { timeout: 30000 });
        expect(actual).toEqual(native);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('preserves native floating-point PCM payload bits for same-format decode/encode', () => {
  const root = mkdtempSync(join(tmpdir(), 'edgeffmpeg-float-pcm-'));
  try {
    for (const codec of ['pcm_f32le', 'pcm_f64le'] as const) {
      const width = codec === 'pcm_f32le' ? 4 : 8;
      const bytes = Uint8Array.from({ length: width * 64 }, (_, i) => (i * 37 + 13) & 255);
      const path = join(root, `${codec}.raw`); writeFileSync(path, bytes);
      const raw = codec.slice(4);
      const native = execFileSync(resolve('.build/reference/ffmpeg'), ['-v','error','-f',raw,'-ar','8000','-ac','1','-i',path,'-c:a',codec,'-f',raw,'-'], { timeout: 30000 });
      const frame = decodePcm({ streamIndex: 0, data: bytes, pts: 0n, dts: 0n, duration: 64n, timeBase: { num: 1n, den: 8000n }, flags: 1 }, { codec, channels: 1, sampleRate: 8000 }, { maxFrameBytes: 4096 });
      expect(Buffer.from(encodePcm(frame, codec, { maxFrameBytes: 4096 }).data)).toEqual(native);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
