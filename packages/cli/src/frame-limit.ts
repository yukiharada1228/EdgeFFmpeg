export class FrameLimitError extends Error {}
/** Decimal signed int64; native negative counts mean no output frame limit. */
export function parseFrameLimit(value: string): bigint | null {
  if (value.length > 128 || !/^[+-]?\d+$/.test(value)) throw new FrameLimitError('Expected a decimal signed 64-bit output frame count');
  const count = BigInt(value);
  if (count < -(1n << 63n) || count > (1n << 63n) - 1n) throw new FrameLimitError('Output frame count exceeds signed 64-bit range');
  return count < 0n ? null : count;
}
