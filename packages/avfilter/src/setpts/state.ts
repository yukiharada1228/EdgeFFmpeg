import type {ExpressionNumericProfile as NumericProfile} from '@edge-ffmpeg/avutil';
// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned libavfilter/setpts.c, Copyright (c) 2010 Stefano Sabatini; Copyright (c) 2008 Victor Paesa.
import type {Rational} from '@edge-ffmpeg/avutil';
import type {ExpressionPrint} from '@edge-ffmpeg/avutil';
import {compileExpression} from '@edge-ffmpeg/avutil';
export const setptsVariables=['FRAME_RATE','INTERLACED','N','NB_CONSUMED_SAMPLES','NB_SAMPLES','PREV_INPTS','PREV_INT','PREV_OUTPTS','PREV_OUTT','PTS','SAMPLE_RATE','STARTPTS','STARTT','T','TB','RTCTIME','RTCSTART','S','SR','FR','T_CHANGE'] as const;
const I=Object.fromEntries(setptsVariables.map((name,index)=>[name,index])) as Record<typeof setptsVariables[number],number>;
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
function timestamp(value:number,profile:NumericProfile):bigint|null{if(Number.isNaN(value))return null;const result=profile==='linux-x64'?(!Number.isFinite(value)||value>=9223372036854775808||value< -9223372036854775808?MIN:BigInt(Math.trunc(value))):(value>=9223372036854775808?MAX:value<=-9223372036854775808?MIN:BigInt(Math.trunc(value)));return result===MIN?null:result;}
/** finish() takes an acknowledged input-link status PTS and returns the raw output status PTS. */
export function createVideoPtsTransform(options:{numericProfile:NumericProfile;expression?:string;timeBase:Rational;frameRate:Rational;stripFps?:boolean;nowMicroseconds?:()=>bigint;onPrint?:(entry:ExpressionPrint)=>void;logLevel?:number}){
 const profile=options.numericProfile;
 const base=Object.freeze({...options.timeBase}),rate=Object.freeze({...options.frameRate}),strip=options.stripFps??false,now=options.nowMicroseconds??(()=>BigInt(Date.now())*1000n);if(base.num<=0n||base.den<=0n||base.num>2147483647n||base.den>2147483647n)throw new Error('Invalid setpts time base');
 const values=new Float64Array(setptsVariables.length),put=(name:typeof setptsVariables[number],value:number)=>{values[I[name]]=value;},get=(name:typeof setptsVariables[number])=>values[I[name]]!;
 const effects=Object.freeze({...(options.onPrint?{onPrint:options.onPrint}:{}),...(options.logLevel===undefined?{}:{logLevel:options.logLevel})});
 let evaluate=compileExpression(options.expression??'PTS',{...effects,nowMicroseconds:now,numericProfile:profile,constants:setptsVariables}),finished=false;
 for(const name of ['PREV_INPTS','PREV_INT','PREV_OUTPTS','PREV_OUTT','STARTPTS','STARTT','T_CHANGE'] as const)put(name,NaN);
 const tb=Number(base.num)/Number(base.den),fr=rate.num!==0n&&rate.den!==0n?Number(rate.num)/Number(rate.den):NaN;put('TB',tb);put('RTCSTART',Number(now()));put('SR',NaN);put('SAMPLE_RATE',NaN);put('FR',fr);put('FRAME_RATE',fr);
 const ptsNumber=(pts:bigint|null)=>{if(pts===null||pts===MIN)return NaN;if(pts<MIN||pts>MAX)throw new Error('Setpts input timestamp exceeds signed64');return Number(pts);};
 const calculate=(pts:bigint|null,interlaced?:boolean)=>{const input=ptsNumber(pts),time=input*tb;if(Number.isNaN(get('STARTPTS'))){put('STARTPTS',input);put('STARTT',time);}if(Number.isNaN(get('T_CHANGE')))put('T_CHANGE',time);put('PTS',input);put('T',time);put('RTCTIME',Number(now()));if(interlaced!==undefined)put('INTERLACED',Number(interlaced));return timestamp(evaluate(values),profile);};
 return {timeBase:base,frameRate:strip?Object.freeze({num:1n,den:0n}):rate,process(frame:{pts:bigint|null;duration:bigint;interlaced?:boolean}){if(finished)throw new Error('Setpts stream already finished');if(typeof frame.duration!=='bigint'||frame.duration<0n)throw new Error('Invalid setpts duration');const pts=calculate(frame.pts,frame.interlaced??false);put('N',get('N')+1);put('PREV_INPTS',ptsNumber(frame.pts));put('PREV_INT',ptsNumber(frame.pts)*tb);put('PREV_OUTPTS',ptsNumber(pts));put('PREV_OUTT',ptsNumber(pts)*tb);return {pts,duration:strip?0n:frame.duration};},finish(pts:bigint|null){if(finished)throw new Error('Setpts stream already finished');const output=calculate(pts);finished=true;return output;},command(expression:string){if(finished)throw new Error('Setpts stream already finished');const next=compileExpression(expression,{...effects,nowMicroseconds:now,numericProfile:profile,constants:setptsVariables});evaluate=next;put('T_CHANGE',NaN);}};
}
