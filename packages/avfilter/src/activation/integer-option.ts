// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped AV_OPT_TYPE_INT expression/range/rounding adaptation of libavutil/opt.c.
import {compileExpression} from '@edge-ffmpeg/avutil';
export function filterIntegerOption(expression:string,options:{min:number;max:number;defaultValue:number;constants?:Readonly<Record<string,number>>}):number{
 const constants={...options.constants,default:options.defaultValue,max:options.max,min:options.min,none:0,all:-1},names=Object.keys(constants),value=compileExpression(expression,{numericProfile:'linux-x64',constants:names})(Float64Array.from(Object.values(constants)));
 if(!Number.isFinite(value)||value<options.min||value>options.max)throw new Error('Integer filter option outside range');
 const lower=Math.floor(value),fraction=value-lower;const result=fraction<0.5?lower:fraction>0.5?lower+1:lower%2===0?lower:lower+1;return result||0;
}
