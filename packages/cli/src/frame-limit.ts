import type { ExpressionNumericProfile } from '@edge-ffmpeg/avutil';
export class FrameLimitError extends Error {}
/** Decimal signed int64; native negative counts mean no output frame limit. */
export function parseFrameLimit(value: string): bigint | null {
  if (value.length > 128 || !/^[+-]?\d+$/.test(value)) throw new FrameLimitError('Expected a decimal signed 64-bit output frame count');
  const count = BigInt(value);
  if (count < -(1n << 63n) || count > (1n << 63n) - 1n) throw new FrameLimitError('Output frame count exceeds signed 64-bit range');
  return count < 0n ? null : count;
}
/** fftools option name of an output frame-count option, as native prints it: -aframes is frames:a, -frames:v:0 stays frames:v:0. */
export function nativeFrameLimitOption(name: string): string | null {
  if (name === '-aframes' || name === '-vframes' || name === '-dframes') return `frames:${name[1]}`;
  return /^-frames(?::.+)?$/.test(name) ? name.slice(1) : null;
}
// Decimal integers whose nearest binary64 is 2^63: from 2^63-512 (a tie that rounds to the even 2^63) to 2^63+1024.
const ROUNDS_TO_2_63 = [(1n << 63n) - 512n, (1n << 63n) + 1024n] as const;
/**
 * The fatal message of a native output frame count that only the given reference rejects, or null.
 *
 * fftools/cmdutils.c parse_number reads the count with av_strtod and rejects `(int64_t)d != d`. When d is 2^63 the
 * cast is undefined behaviour: AArch64 FCVTZS saturates to INT64_MAX, which converts back to 2^63, so darwin-arm64
 * accepts the count; x86-64 CVTTSD2SI returns INT64_MIN, so linux-x64 rejects it with
 * `Expected int64 for frames:a but found 9223372036854775807` and AVERROR(EINVAL) (exit status 234). Only decimal
 * counts in Edge's syntax are classified; every other count keeps parseFrameLimit's handling.
 */
export function nativeFrameLimitRejection(name: string, value: string | null, profile: ExpressionNumericProfile): string | null {
  if (profile !== 'darwin-arm64' && profile !== 'linux-x64') throw new FrameLimitError('Unknown native numeric profile');
  const option = nativeFrameLimitOption(name);
  if (profile !== 'linux-x64' || option === null || value === null || value.length > 128 || !/^[+-]?\d+$/.test(value)) return null;
  const count = BigInt(value);
  return count >= ROUNDS_TO_2_63[0] && count <= ROUNDS_TO_2_63[1] ? `Expected int64 for ${option} but found ${value}` : null;
}
