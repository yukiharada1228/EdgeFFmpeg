import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyFlacChannelMask, parseReferenceLong, resolveFlacLayout } from '../../packages/containers/src/flac/channel-mask.js';
import type {FlacChannelMaskResult,FlacMaskEntry} from '../../packages/containers/src/flac/channel-mask.js';
const key = 'WAVEFORMATEXTENSIBLE_CHANNEL_MASK';
const fixtureBytes = readFileSync(new URL('../../compat/behavior-specs/flac-channel-mask/native-channel-masks.json', import.meta.url));
const corpus = JSON.parse(fixtureBytes.toString()) as { rows: { id: string; values: string[]; input: string; inputSha256: string; native: { tags: Record<string, string>; streams: { channels: number; channel_layout: string }[] } }[] };
it('preserves the finite pinned Native evidence and compares its 40 stereo cases', () => {
  expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe('a502cc488d3f330678573949e278eeb6d8dc0e4da82c713b013b9e5890553ad3');
  expect(corpus.rows).toHaveLength(40);
  for (const row of corpus.rows) {
    expect(createHash('sha256').update(Buffer.from(row.input, 'base64')).digest('hex'), row.id).toBe(row.inputSha256);
    let entries: readonly { readonly key: string; readonly value: string }[] = [];
    let mask: bigint | null = null;
    for (const value of row.values) {
      // Upstream comment parsing ignores empty values before this helper.
      if (value.length === 0) continue;
      // The upstream dictionary replaces the same key between comment blocks.
      entries = [...entries.filter(e => e.key !== key), { key, value }];
      const effect: FlacChannelMaskResult<FlacMaskEntry> = applyFlacChannelMask(entries, mask);
      entries = effect.entries; mask = effect.mask;
    }
    expect(Object.fromEntries(entries.map(e => [e.key, e.value])), row.id).toEqual(row.native.tags);
    const native = row.native.streams[0]!;
    expect(resolveFlacLayout(native.channels, mask).name, row.id).toBe(native.channel_layout);
  }
});
it.each([
  ['', 0n], ['foo', 0n], ['0x', 0n], ['08', 0n], ['0b11', 0n], ['03tail', 3n],
  [' \t\n\v\f\r-0x3tail', -3n], ['\u00a03', 0n], ['٠٣', 0n], ['+0X03zzz', 3n],
  ['9223372036854775807', (1n << 63n) - 1n], ['9223372036854775808', (1n << 63n) - 1n],
  ['18446744073709551619', (1n << 63n) - 1n], ['-9223372036854775808', -(1n << 63n)],
  ['-9223372036854775809', -(1n << 63n)], ['9'.repeat(10000), (1n << 63n) - 1n],
] as const)('models pinned LP64 conversion of %s', (text, expected) => expect(parseReferenceLong(text)).toBe(expected));
it('consumes only the first ASCII case-insensitive duplicate and swaps the last entry into its slot', () => {
  const first = Object.freeze({ key: key.toLowerCase(), value: '3', extra: true });
  const second = Object.freeze({ key, value: '48', extra: false });
  const tail = Object.freeze({ key: 'TITLE', value: 'track', extra: false });
  const entries = Object.freeze([first, second, tail]);
  const result = applyFlacChannelMask(entries);
  expect(result.entries).toEqual([tail, second]); expect(result.entries[0]).toBe(tail);
  expect(result.mask).toBe(3n); expect(entries).toEqual([first, second, tail]);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.entries)).toBe(true);
  expect(applyFlacChannelMask([{ key, value: 'bad' }, second], 48n)).toMatchObject({ mask: 48n, invalid: true, present: true });
});
it('retains invalid tags and the prior mask at acceptance boundaries', () => {
  for (const value of ['0', '-1', '262144', '9223372036854775808']) {
    const entries = [{ key, value }];
    expect(applyFlacChannelMask(entries, 3n)).toEqual({ entries, mask: 3n, present: true, invalid: true });
  }
  expect(applyFlacChannelMask([{ key, value: '262143' }]).mask).toBe(0x3ffffn);
  expect(applyFlacChannelMask([], 48n)).toEqual({ entries: [], mask: 48n, present: false, invalid: false });
});
it('uses source-derived FLAC defaults for all eight channel counts', () => {
  [4n, 3n, 7n, 51n, 1543n, 1551n, 1807n, 1599n].forEach((mask, i) => {
    expect(resolveFlacLayout(i + 1)).toMatchObject({ mask, fromComment: false });
    expect(resolveFlacLayout(i + 1, 0n).mask).toBe(mask);
  });
  expect(resolveFlacLayout(2, 1n)).toMatchObject({ mask: 3n, fromComment: false });
  expect(resolveFlacLayout(2, 48n)).toEqual({ channels: 2, mask: 48n, name: '2 channels (BL+BR)', fromComment: true });
  expect(Object.isFrozen(resolveFlacLayout(1))).toBe(true);
});
it('rejects layout counts and masks outside the explicit scope', () => {
  for (const count of [0, -1, 9, 1.5, NaN, Infinity]) expect(() => resolveFlacLayout(count)).toThrow(RangeError);
  for (const mask of [-1n, 0x40000n, 1n << 64n]) expect(() => resolveFlacLayout(2, mask)).toThrow(RangeError);
  expect(() => parseReferenceLong(null as unknown as string)).toThrow(TypeError);
});
