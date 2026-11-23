export interface Rational { readonly num: bigint; readonly den: bigint }
export interface Timestamp { readonly value: bigint; readonly timeBase: Rational }
export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError("Zero denominator");
  if (den < 0n) { num = -num; den = -den; }
  let a = num < 0n ? -num : num; let b = den;
  while (b !== 0n) { const r = a % b; a = b; b = r; }
  return { num: num / a, den: den / a };
}
/** Rescale with explicit rounding; no floating point intermediates. */
export function rescale(value: bigint, source: Rational, target: Rational, rounding: "zero" | "near" = "near"): bigint {
  if (source.den <= 0n || target.den <= 0n || target.num <= 0n || source.num <= 0n)
    throw new RangeError("Time bases must be positive");
  const numerator = value * source.num * target.den;
  const denominator = source.den * target.num;
  if (rounding === "zero") return numerator / denominator;
  const magnitude = numerator < 0n ? -numerator : numerator;
  const result = (magnitude + denominator / 2n) / denominator;
  return numerator < 0n ? -result : result;
}
