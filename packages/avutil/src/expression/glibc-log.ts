// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from glibc 2.36 e_log.c, non-FMA path.
// Copyright (C) 2018-2022 Free Software Foundation, Inc.
import {bits,fromBits,wrap64} from './glibc-bits.js';
import {logLn2Hi as ln2hi,logLn2Lo as ln2lo,logPoly as A,logNearPoly as B,logTable as T,logTable2 as T2} from './glibc-tables.js';
export function glibcLog(x:number):number{if(x>=1-2**-4&&x<1+(1+9/256)*2**-4){if(x===1)return 0;const r=x-1,r2=r*r,r3=r*r2;let y=r3*(B[1]!+r*B[2]!+r2*B[3]!+r3*(B[4]!+r*B[5]!+r2*B[6]!+r3*(B[7]!+r*B[8]!+r2*B[9]!+r3*B[10]!)));let w=r*2**27;const rhi=r+w-w,rlo=r-rhi;w=rhi*rhi*B[0]!;const hi=r+w;let lo=r-hi+w;lo+=B[0]!*rlo*(rhi+r);y+=lo;y+=hi;return y;}if(x===0)return -Infinity;if(x===Infinity)return x;if(x<0||Number.isNaN(x))return NaN;let ix=bits(x);if(x<2**-1022)ix=wrap64(bits(x*2**52)-(52n<<52n));const tmp=wrap64(ix-0x3fe6000000000000n),i=Number((tmp>>45n)%128n),k=Number(BigInt.asIntN(64,tmp)>>52n),iz=wrap64(ix-(tmp&(0xfffn<<52n))),invc=T[i]![0]!,logc=T[i]![1]!,z=fromBits(iz),r=(z-T2[i]![0]!-T2[i]![1]!)*invc,w=k*ln2hi+logc,hi=w+r,lo=w-hi+r+k*ln2lo,r2=r*r;return lo+r2*A[0]!+r*r2*(A[1]!+r*A[2]!+r2*(A[3]!+r*A[4]!))+hi;}
