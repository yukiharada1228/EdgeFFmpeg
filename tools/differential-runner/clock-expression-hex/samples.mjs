// The 324 signed hexadecimal clock-expression samples of tests/differential/video-clock-hex-value.test.ts, in test
// order. A doubled sign makes av_expr's parse_pow consume one sign and av_strtod pass the signed literal to strtod.
export const CLOCK_HEX_MANTISSAS=Object.freeze(['1','1.8','.8','fffffffffffffffff','1.00000000000008','1.00000000000018','0.fffffffffffff8','1.fffffffffffff8','0']);
export const CLOCK_HEX_EXPONENTS=Object.freeze(['p0','p-1022','p-1074','p-1075','p-1076','p1023','p1024','p-99999','p99999']);
export const CLOCK_HEX_SIGNS=Object.freeze(['--','+-','-+','++']);
export function clockHexSamples(){
 const samples=[];
 for(const mantissa of CLOCK_HEX_MANTISSAS)for(const exponent of CLOCK_HEX_EXPONENTS)for(const sign of CLOCK_HEX_SIGNS)samples.push(`${sign}0x${mantissa}${exponent}`);
 return samples;
}
