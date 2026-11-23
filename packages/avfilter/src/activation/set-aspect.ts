import {doubleToBoundedRational} from "./double-rational.js";
// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted vf_aspect.c and rational.c av_d2q; see upstream copyrights.
import {compileExpression} from '@edge-ffmpeg/avutil';import type {Rational,ExpressionNumericProfile} from '@edge-ffmpeg/avutil';import {reduceAspectRational} from "./scale-aspect.js";
export const aspectVariables=['w','h','a','dar','sar','hsub','vsub'] as const;
export function evaluateSetAspect(expression:string,max:number,input:{width:number;height:number;format:string;sampleAspectRatio?:Rational},profile:ExpressionNumericProfile):Rational{
 const sar=input.sampleAspectRatio?.num?Number(input.sampleAspectRatio.num)/Number(input.sampleAspectRatio.den):1,sub=['yuv420p','yuv422p','yuva420p','nv12','nv21'].includes(input.format)?2:1,vsub=['yuv420p','yuva420p','nv12','nv21'].includes(input.format)?2:1;
 let value:number;try{value=compileExpression(expression,{numericProfile:profile,constants:aspectVariables})(Float64Array.of(input.width,input.height,input.width/input.height,input.width/input.height*sar,sar,sub,vsub));}catch(error){const ratio=/^\s*([+]?\d+)\s*:\s*([+]?\d+)\s*$/.exec(expression);if(!ratio)throw error;if(BigInt(ratio[2]!)===0n)throw new Error('Invalid aspect expression result');return reduceAspectRational(BigInt(ratio[1]!),BigInt(ratio[2]!),BigInt(max));}
 const result=doubleToBoundedRational(value,max);if(result.num<0n||result.den<=0n)throw new Error('Invalid aspect expression result');return result;
}
