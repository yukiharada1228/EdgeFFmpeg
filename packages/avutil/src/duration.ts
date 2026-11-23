export class TimeSyntaxError extends Error {}
/** FFmpeg duration syntax in integer microseconds. Excess fractional precision is truncated. */
export function parseTimeDuration(text: string): bigint {
  if (text.length > 128) throw new TimeSyntaxError('Time value is too long');
  const match = /^([ \t\r\n\v\f]*)([+-]?)(\d+(?::\d{1,2}){0,2})(?:\.(\d*))?(us|ms|s)?$/.exec(text);
  if (!match) throw new TimeSyntaxError(`Invalid time duration: ${text}`);
  const parts = match[3]!.split(':'), sign = match[2] === '-' ? -1n : 1n;
  if (parts.length > 1 && (match[2] === '+' || match[1] !== '')) throw new TimeSyntaxError('Unsupported signed/whitespace clock syntax');
  if (parts.length === 2 && (parts[0]!.length > 2 || BigInt(parts[0]!) > 59n)) throw new TimeSyntaxError('Invalid clock minutes');
  if (parts.length > 1 && (BigInt(parts.at(-1)!) > 59n || (parts.length === 3 && BigInt(parts[1]!) > 59n))) throw new TimeSyntaxError('Invalid clock component');
  let seconds = 0n;
  for (const part of parts) seconds = seconds * 60n + BigInt(part);
  const fraction = match[4] ?? '';
  const denominator = 10n ** BigInt(fraction.length);
  const multiplier = match[5] === 'us' ? 1n : match[5] === 'ms' ? 1000n : 1000000n;
  const result = sign * ((seconds * denominator + BigInt(fraction || '0')) * multiplier / denominator);
  if (result < -(1n << 63n) || result > (1n << 63n) - 1n) throw new TimeSyntaxError('Time duration exceeds signed 64-bit microseconds');
  return result;
}
