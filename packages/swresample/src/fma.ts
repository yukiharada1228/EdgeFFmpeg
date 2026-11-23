/** Exact finite IEEE binary multiply/add followed by one nearest-even rounding.
 * Used to reproduce an explicitly selected scalar compiler contraction profile.
 */
export function fusedMultiplyAdd(a:number,b:number,c:number,precision:24|53):number{
  if(!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(c))throw new RangeError('Finite FMA operands required');
  const view=new DataView(new ArrayBuffer(8));
  const parts=(value:number)=>{view.setFloat64(0,value,false);const bits=view.getBigUint64(0,false),field=Number((bits>>52n)&2047n);return {negative:(bits>>63n)!==0n,mantissa:(bits&((1n<<52n)-1n))|(field?1n<<52n:0n),exponent:field?field-1075:-1074};};
  const x=parts(a),y=parts(b),z=parts(c),negativeProduct=x.negative!==y.negative,product=x.mantissa*y.mantissa;
  if(product===0n){if(z.mantissa===0n)return negativeProduct&&z.negative?-0:0;return precision===24?Math.fround(c):c;}
  const productExponent=x.exponent+y.exponent,exponent=z.mantissa===0n?productExponent:Math.min(productExponent,z.exponent);
  const sum=(negativeProduct?-product:product)<<BigInt(productExponent-exponent);
  const combined=sum+(z.mantissa===0n?0n:(z.negative?-z.mantissa:z.mantissa)<<BigInt(z.exponent-exponent));
  // A zero addend has no significand, so its nominal exponent is immaterial.
  if(combined===0n)return 0;
  const negative=combined<0n,magnitude=negative?-combined:combined,top=exponent+magnitude.toString(2).length-1,minimum=precision===24?-126:-1022,maximum=precision===24?127:1023;
  const step=Math.max(top-(precision-1),minimum-(precision-1)),shift=step-exponent;
  let rounded:bigint;
  if(shift>0){const distance=BigInt(shift),lower=magnitude>>distance,remainder=magnitude-(lower<<distance),half=1n<<(distance-1n);rounded=lower+(remainder>half||(remainder===half&&(lower&1n)!==0n)?1n:0n);}
  else rounded=magnitude<<BigInt(-shift);
  if(rounded===0n)return negative?-0:0;
  const value=step+rounded.toString(2).length-1>maximum?Infinity:Number(rounded)*2**step;
  return negative?-value:value;
}
