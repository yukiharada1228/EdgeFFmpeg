import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { rational, rescale } from '@edge-ffmpeg/avutil';
// This suite is excluded from the unit command and must fail if the oracle is absent.
it('matches native settb timestamp rescaling at fractional frame rates', () => {
  const lock = JSON.parse(readFileSync('compat/upstream.lock.json', 'utf8')) as { commit: string };
  const metadata = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8')) as { commit: string };
  expect(metadata.commit).toBe(lock.commit);
  for (const rate of ['30000/1001', '24000/1001', '25/1']) {
    const result = spawnSync(resolve('.build/reference/ffmpeg'), [
      '-hide_banner', '-f', 'lavfi', '-i', `testsrc=size=16x16:rate=${rate}`,
      '-vf', 'settb=expr=1/1000,showinfo', '-frames:v', '8', '-f', 'null', '-'
    ], { encoding: 'utf8', timeout: 30000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const frames = [...result.stderr.matchAll(/n:\s*(\d+)\s+pts:\s*(-?\d+)/g)].slice(0, 8);
    expect(frames.length).toBe(8);
    const [num, den] = rate.split('/').map(BigInt);
    for (const frame of frames) {
      expect(rescale(BigInt(frame[1]!), rational(den!, num!), rational(1n, 1000n))).toBe(BigInt(frame[2]!));
    }
  }
});
