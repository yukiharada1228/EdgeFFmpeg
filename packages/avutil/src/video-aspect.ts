// SPDX-License-Identifier: LGPL-2.1-or-later
// Aspect-ratio composition follows pinned vf_scale.c / libavutil rational.c;
// bounded-rational.ts retains the adapted av_reduce implementation and notice.
import {reduceBoundedRational} from './bounded-rational.js';
import type {Rational} from './rational.js';
/** Native scale preserves display aspect using bounded av_mul_q-style ratios. */
export function scaleSampleAspectRatio(sar:Rational,width:number,height:number,outputWidth:number,outputHeight:number):Rational {
 if(typeof sar?.num!=='bigint'||typeof sar.den!=='bigint'||sar.num<0n||sar.num>2147483647n||sar.den<1n||sar.den>2147483647n)throw new RangeError('Invalid sample aspect ratio');
 for(const value of [width,height,outputWidth,outputHeight])if(!Number.isInteger(value)||value<1||value>2147483647)throw new RangeError('Invalid sample aspect geometry');
 if(!sar.num)return Object.freeze({num:0n,den:1n});const ratio=reduceBoundedRational(BigInt(width)*BigInt(outputHeight),BigInt(height)*BigInt(outputWidth)),result=reduceBoundedRational(sar.num*ratio.num,sar.den*ratio.den);return Object.freeze({num:result.num,den:result.den});
}
