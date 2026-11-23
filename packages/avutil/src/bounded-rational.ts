// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from FFmpeg libavutil/rational.c av_reduce.
// Copyright (c) 2003 Michael Niedermayer <michaelni@gmx.at>
import type {Rational} from './rational.js';
export interface ReducedRational extends Rational {readonly exact:boolean}
/** Native av_reduce semantics for representable magnitudes <= INT64_MAX.
 * Zero denominators represent infinity or 0/0. INT64_MIN is rejected because
 * upstream's signed absolute value is undefined there; no portable claim is made.
 */
export function reduceBoundedRational(num:bigint,den:bigint,max=2147483647n):ReducedRational {
 const limit=9223372036854775807n;
 if(typeof num!=='bigint'||typeof den!=='bigint'||typeof max!=='bigint'||num< -limit||num>limit||den< -limit||den>limit||max<1n||max>2147483647n)throw new RangeError('Invalid bounded rational input');
 const negative=(num<0n)!==(den<0n);if(num<0n)num=-num;if(den<0n)den=-den;
 let a=num,b=den;while(b){const remainder=a%b;a=b;b=remainder;}if(a){num/=a;den/=a;}
 let n0=0n,d0=1n,n1=1n,d1=0n;
 if(num<=max&&den<=max){n1=num;d1=den;den=0n;}
 while(den){
  let quotient=num/den;const remainder=num-den*quotient,n2=quotient*n1+n0,d2=quotient*d1+d0;
  if(n2>max||d2>max){
   if(n1)quotient=(max-n0)/n1;
   if(d1){const bound=(max-d0)/d1;if(bound<quotient)quotient=bound;}
   if(den*(2n*quotient*d1+d0)>num*d1){n1=quotient*n1+n0;d1=quotient*d1+d0;}
   break;
  }
  n0=n1;d0=d1;n1=n2;d1=d2;num=den;den=remainder;
 }
 return Object.freeze({num:negative?-n1:n1,den:d1,exact:den===0n});
}
