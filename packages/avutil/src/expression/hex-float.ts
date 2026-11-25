// SPDX-License-Identifier: LGPL-2.1-or-later
// The linux-x64 rounding follows glibc 2.36 stdlib/strtod_l.c round_and_return.
// Copyright (C) 1997-2022 Free Software Foundation, Inc.
import type {NumericProfile} from './numeric-profile.js';
const literal=/^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/;
/**
 * The binary64 value that the reference C library's strtod returns, in round-to-nearest mode, for a hexadecimal
 * floating literal `[+-]0x<digits>[.<digits>][p[+-]<decimal exponent>]`. av_strtod reaches strtod for signed hexadecimal
 * literals only; unsigned ones go through strtoul.
 *
 * - darwin-arm64: macOS libc, correctly rounded to nearest, ties to even.
 * - linux-x64: glibc 2.36. For a subnormal result, round_and_return (strtod_l.c line 226) folds into the sticky bits
 *   only the bits below the parser's round bit, the 54th significant bit, and then rounds again at the subnormal
 *   precision. When that 54th bit is the only nonzero bit below the new round bit, the value is treated as an exact tie:
 *   0x1.00000000000008p-1075 gives +0 instead of 0x1p-1074. Normal results are correctly rounded.
 *
 * Verified against glibc 2.36-9+deb12u14 in the pinned image on the 324 clock-expression samples and 179,095 generated
 * literals (docs/contributing/expressions.md).
 */
export function hexFloatLiteral(text:string,profile:NumericProfile):number{
 if(profile!=='darwin-arm64'&&profile!=='linux-x64')throw new Error('Unknown numeric profile');
 const parts=literal.exec(text);if(!parts||!(parts[2]||parts[3]))throw new Error('Not a hexadecimal floating literal');
 const fraction=parts[3]??'',mantissa=BigInt('0x'+((parts[2]??'')+fraction||'0')),sign=parts[1]==='-'?-1:1;if(!mantissa)return sign*0;
 const exponent=Number(parts[4]??0)-4*fraction.length,bits=mantissa.toString(2).length,top=bits-1+exponent;if(top>1023)return sign*Infinity;if(top< -1075)return sign*0;
 const unit=Math.max(top-52,-1074),shift=unit-exponent;let rounded:bigint;
 if(shift<=0)rounded=mantissa<<BigInt(-shift);
 else{
  const divisor=1n<<BigInt(shift),quotient=mantissa/divisor;let remainder=mantissa%divisor;
  // Subnormal (top below -1022): the shift moves the round bit above the 54th significant bit, which glibc drops.
  if(profile==='linux-x64'&&top< -1022&&bits>53)remainder&=~(1n<<BigInt(bits-54));
  rounded=quotient+(remainder*2n>divisor||(remainder*2n===divisor&&(quotient&1n)===1n)?1n:0n);
 }
 return sign*Number(rounded)*Math.pow(2,unit);
}
