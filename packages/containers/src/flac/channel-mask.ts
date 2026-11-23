/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Adapted from FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8:
 * libavformat/flacdec.c (Copyright (c) 2001 Fabrice Bellard),
 * libavcodec/flac.c (Copyright (c) 2009 Justin Ruggles), and
 * libavutil/channel_layout.h (Copyright (c) 2006 Michael Niedermayer;
 * Copyright (c) 2008 Peter Ross).
 * Numeric conversion models the pinned Mac LP64 strtol(base 0), not other
 * libc profiles. Layouts are provisional until frame channel counts are known.
 */
export interface FlacMaskEntry { readonly key: string; readonly value: string }
export interface FlacChannelMaskResult<T extends FlacMaskEntry> {
  readonly entries: readonly T[];
  readonly mask: bigint | null;
  readonly invalid: boolean;
  readonly present: boolean;
}
export interface FlacLayout {
  readonly channels: number;
  readonly mask: bigint;
  readonly name: string;
  readonly fromComment: boolean;
}
const fold = (text: string): string => text.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) - 32));
function digit(char: string | undefined): number {
  if (char === undefined) return -1;
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
}
/** Signed 64-bit saturation precedes the caller's uint64 conversion. */
export function parseReferenceLong(text: string): bigint {
  if (typeof text !== 'string') throw new TypeError('Invalid mask text');
  let at = 0;
  while (at < text.length && /[\x09-\x0d ]/.test(text[at]!)) at++;
  let negative = false;
  if (text[at] === '+' || text[at] === '-') negative = text[at++] === '-';
  let radix = 10;
  if (text[at] === '0') {
    if ((text[at + 1] === 'x' || text[at + 1] === 'X') && digit(text[at + 2]) >= 0 && digit(text[at + 2]) < 16) {
      radix = 16; at += 2;
    } else radix = 8;
  }
  const limit = negative ? 1n << 63n : (1n << 63n) - 1n;
  let value = 0n;
  for (; at < text.length; at++) {
    const n = digit(text[at]);
    if (n < 0 || n >= radix) break;
    value = value * BigInt(radix) + BigInt(n);
    if (value > limit) return negative ? -limit : limit;
  }
  return negative ? -value : value;
}
/** Only the first matching ordered entry is consumed, using av_dict_set removal order.
 * Entry objects remain borrowed; only the result array is owned. No byte buffers or I/O.
 */
export function applyFlacChannelMask<T extends FlacMaskEntry>(entries: readonly T[], previousMask: bigint | null = null): FlacChannelMaskResult<T> {
  const result = entries.slice();
  const index = result.findIndex(e => fold(e.key) === 'WAVEFORMATEXTENSIBLE_CHANNEL_MASK');
  if (index < 0) return Object.freeze({ entries: Object.freeze(result), mask: previousMask, invalid: false, present: false });
  const mask = BigInt.asUintN(64, parseReferenceLong(result[index]!.value));
  if (!mask || (mask & ~0x3ffffn) !== 0n) return Object.freeze({ entries: Object.freeze(result), mask: previousMask, invalid: true, present: true });
  result[index] = result[result.length - 1]!;
  result.pop();
  return Object.freeze({ entries: Object.freeze(result), mask, invalid: false, present: true });
}
const defaults = [4n, 3n, 7n, 51n, 1543n, 1551n, 1807n, 1599n] as const;
const names = new Map<bigint, string>([[4n, 'mono'], [3n, 'stereo'], [7n, '3.0'], [51n, 'quad'], [1543n, '5.0(side)'], [1551n, '5.1(side)'], [1807n, '6.1'], [1599n, '7.1']]);
const channels = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'BC', 'SL', 'SR', 'TC', 'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR'];
export function resolveFlacLayout(count: number, declaredMask: bigint | null = null): FlacLayout {
  if (!Number.isSafeInteger(count) || count < 1 || count > 8 || (declaredMask !== null && (typeof declaredMask !== 'bigint' || declaredMask < 0n || (declaredMask & ~0x3ffffn) !== 0n))) throw new RangeError('Invalid FLAC layout input');
  let bits = 0;
  if (declaredMask !== null) for (let mask = declaredMask; mask; mask >>= 1n) bits += Number(mask & 1n);
  const fromComment = declaredMask !== null && bits === count;
  const mask = fromComment ? declaredMask! : defaults[count - 1]!;
  const name = names.get(mask) ?? `${count} channels (${channels.filter((_name, i) => !!(mask & (1n << BigInt(i)))).join('+')})`;
  return Object.freeze({ channels: count, mask, name, fromComment });
}
