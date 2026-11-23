// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted FFmpeg libavutil/rational.c av_d2q, Copyright (c) 2003 Michael Niedermayer.
import {reduceBoundedRational} from './bounded-rational.js';import type {Rational} from './rational.js';
export function numberToBoundedRational(value:number,max=2147483647):Rational{
 if(typeof value!=='number'||!Number.isInteger(max)||max<1||max>2147483647)throw new RangeError('Invalid double rational input');
 if(Number.isNaN(value))return Object.freeze({num:0n,den:0n});
 if(Math.abs(value)>2147483650)return Object.freeze({num:value<0?-1n:1n,den:0n});
 const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value);const exponent=Math.max(((view.getUint32(0)>>>20)&2047)-1023,0),den=1n<<BigInt(62-exponent),result=reduceBoundedRational(BigInt(Math.floor(value*Number(den)+0.5)),den,BigInt(max));
 return Object.freeze({num:result.num,den:result.den});
}
