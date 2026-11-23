// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from FFmpeg libavutil/rational.c av_reduce (Fabrice Bellard, Michael Niedermayer).
import {reduceBoundedRational} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
export function scaledSampleAspectRatio(sar:Rational,iw:number,ih:number,ow:number,oh:number):Rational{
 if(typeof sar.num!=='bigint'||typeof sar.den!=='bigint'||sar.num<0n||sar.num>2147483647n||sar.den<=0n||sar.den>2147483647n||![iw,ih,ow,oh].every(n=>Number.isInteger(n)&&n>0&&n<=2147483647))throw new Error('Invalid scale sample aspect ratio');
 const num=sar.num*BigInt(oh)*BigInt(iw),den=sar.den*BigInt(ow)*BigInt(ih);if(num>9223372036854775807n||den>9223372036854775807n)throw new Error('Scale aspect product exceeds signed64');
 return reduceAspectRational(num,den);
}
export function reduceAspectRational(num:bigint,den:bigint,max=2147483647n):Rational{
 if(num<0n||den<0n||max<1n||max>2147483647n)throw new Error('Invalid bounded aspect rational');
 const value=reduceBoundedRational(num,den,max);return Object.freeze({num:value.num,den:value.den});
}
