// SPDX-License-Identifier: LGPL-2.1-or-later
// av_reduce/av_d2q adapted from pinned libavutil/rational.c,
// Copyright (c) 2003 Michael Niedermayer. General av_expr functions/state remain unimplemented.
import {evaluateClockExpression} from './clock-expression.js';
import type {Rational} from '@edge-ffmpeg/avutil';
const MAX=2147483647n;
function reduce(numerator:bigint,denominator:bigint):Rational{
 const sign=(numerator<0n)!==(denominator<0n);let num=numerator<0n?-numerator:numerator,den=denominator<0n?-denominator:denominator,a=num,b=den;
 while(b){const r=a%b;a=b;b=r;}if(a){num/=a;den/=a;}
 let a0={num:0n,den:1n},a1={num:1n,den:0n};if(num<=MAX&&den<=MAX){a1={num,den};den=0n;}
 while(den){let x=num/den;const nextDen=num-den*x,a2={num:x*a1.num+a0.num,den:x*a1.den+a0.den};if(a2.num>MAX||a2.den>MAX){if(a1.num)x=(MAX-a0.num)/a1.num;if(a1.den){const bound=(MAX-a0.den)/a1.den;if(x>bound)x=bound;}if(den*(2n*x*a1.den+a0.den)>num*a1.den)a1={num:x*a1.num+a0.num,den:x*a1.den+a0.den};break;}a0=a1;a1=a2;num=den;den=nextDen;}
 return {num:sign?-a1.num:a1.num,den:a1.den};
}
function fromDouble(value:number):Rational{
 if(Number.isNaN(value))return {num:0n,den:0n};if(Math.abs(value)>2147483650)return {num:value<0?-1n:1n,den:0n};
 const bytes=new ArrayBuffer(8),view=new DataView(bytes);view.setFloat64(0,value,false);const exponent=Math.max(Number((view.getBigUint64(0,false)>>52n)&2047n)-1023,0),den=1n<<BigInt(62-exponent),num=BigInt(Math.floor(value*Number(den)+0.5));return reduce(num,den);
}
/** Bounded arithmetic/scientific expressions and exact integer colon ratios. */
export function parseEncoderTimeBase(value:string):Rational|'demux'|'filter'|undefined{
 if(value==='demux'||value==='filter')return value;if(value.length>256)throw new Error('Encoder clock expression exceeds bound');
 const colon=/^([+-]?\d+):([+-]?\d+)$/.exec(value);let result:Rational;
 if(colon){const n=BigInt(colon[1]!),d=BigInt(colon[2]!);if(n< -2147483648n||n>MAX||d< -2147483648n||d>MAX)throw new Error('Encoder integer ratio exceeds signed32');result=reduce(n,d);}else result=fromDouble(evaluateClockExpression(value));
 if(result.den<=0n||result.num<0n)throw new Error('Invalid encoder timebase');return result.num===0n?undefined:Object.freeze(result);
}
