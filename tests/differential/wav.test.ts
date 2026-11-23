import { FFmpeg } from '@edge-ffmpeg/core';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openWav, muxWav } from '@edge-ffmpeg/containers';
it('matches native WAV stream metadata, PCM bytes and sample positions', async () => {
  const lock = JSON.parse(readFileSync('compat/upstream.lock.json', 'utf8')) as { commit: string };
  const metadata = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8')) as { commit: string };
  expect(metadata.commit).toBe(lock.commit);
  const directory = mkdtempSync(join(tmpdir(), 'edgeffmpeg-wav-'));
  try {
    const filesystem = await createNodeFileSystem({ root: directory, maxReadBytes: 1024, maxWriteBytes: 127 });
    const frontend = new FFmpeg({ filesystem, backend: createWavBackend(), budget: { maxResidentBytes: 4096, maxBufferBytes: 127, maxPendingPackets: 2, maxCpuTimeMs: 1000 } });
    for (const codec of ['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le'] as const) {
      const file = join(directory, `${codec}.wav`);
      execFileSync(resolve('.build/reference/ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=0.053', '-ac', '2', '-c:a', codec, file], { timeout: 30000 });
      const probe = JSON.parse(execFileSync(resolve('.build/reference/ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 })) as { streams: Array<{ codec_name: string; sample_rate: string; channels: number; duration_ts: number; time_base: string }> };
      const input = await openWav(await filesystem.openRead(`/${codec}.wav`), { maxReadBytes: 1024 });
      const stream = probe.streams[0]!;
      expect(input.info.codec).toBe(stream.codec_name); expect(input.info.channels).toBe(stream.channels);
      expect(input.info.sampleRate).toBe(Number(stream.sample_rate)); expect(input.info.durationSamples).toBe(BigInt(stream.duration_ts));
      expect(stream.time_base).toBe(`1/${input.info.sampleRate}`);
      const packets = []; let nextSample = 0n;
      for await (const packet of input.packets()) {
        expect(packet.pts).toBe(nextSample); expect(packet.dts).toBe(nextSample);
        nextSample += packet.duration!; packets.push(packet.data);
      }
      expect(nextSample).toBe(input.info.durationSamples);
      const rawFormat = codec === 'pcm_u8' ? 'u8' : codec.slice(4);
      const native = execFileSync(resolve('.build/reference/ffmpeg'), ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', rawFormat, '-'], { timeout: 30000 });
      expect(Buffer.concat(packets)).toEqual(native);
      const seekSample = 5n;
      const tail = []; for await (const packet of input.packets(seekSample)) tail.push(packet.data);
      expect(Buffer.concat(tail)).toEqual(native.subarray(Number(seekSample) * input.info.blockAlign));
      const remuxed = join(directory, `${codec}.remux.wav`);
      await muxWav(await filesystem.openWrite(`/${codec}.remux.wav`), { codec, channels: input.info.channels, sampleRate: input.info.sampleRate, channelMask: input.info.channelMask }, input.packets(), { sampleCount: input.info.durationSamples, maxWriteBytes: 127 });
      const actualStream = JSON.parse(execFileSync(resolve('.build/reference/ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', remuxed], { encoding: 'utf8', timeout: 30000 })) as typeof probe;
      expect(actualStream.streams[0]).toMatchObject({ codec_name: stream.codec_name, sample_rate: stream.sample_rate, channels: stream.channels, duration_ts: stream.duration_ts, time_base: stream.time_base });
      const remuxedPcm = execFileSync(resolve('.build/reference/ffmpeg'), ['-v', 'error', '-i', remuxed, '-map', '0:a:0', '-c:a', 'copy', '-f', rawFormat, '-'], { timeout: 30000 });
      expect(remuxedPcm).toEqual(native);
      const executed = await frontend.exec(['-i', `/${codec}.wav`, '-map', '0:a:0', '-c:a', 'copy', `/${codec}.cli.wav`]);
      expect(executed.exitCode, JSON.stringify(executed.diagnostics)).toBe(0);
      const cliPcm = execFileSync(resolve('.build/reference/ffmpeg'), ['-v', 'error', '-i', join(directory, `${codec}.cli.wav`), '-c:a', 'copy', '-f', rawFormat, '-'], { timeout: 30000 });
      expect(cliPcm).toEqual(native);


    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
