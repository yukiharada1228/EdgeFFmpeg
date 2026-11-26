// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_addroi.c and the AV_OPT_TYPE_RATIONAL/BOOL paths of libavutil/opt.c. See ../../NOTICE-ADDROI.
import {compileExpression,numberToBoundedRational} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import {filterBoolean} from './options.js';
/** qoffset is the stored AVRational; the region strings stay as written. The ROI side data is not represented: no encoder of the pinned
 * build reads AV_FRAME_DATA_REGIONS_OF_INTEREST, so frames, timestamps and sizes pass unchanged on every path. */
export type AddroiStep={readonly name:'addroi';readonly x:string;readonly y:string;readonly w:string;readonly h:string;readonly qoffset:{readonly num:number;readonly den:number};readonly clear:boolean};
export interface AddroiRegion {readonly x:number;readonly y:number;readonly w:number;readonly h:number}
type Range=readonly [number,number];
const regionNames=['x','y','w','h'] as const,profile='linux-x64',space=/[ \t\n\v\f\r]/g,int32=2147483647;
/** Every link size: config_input reads inlink->w and inlink->h, both positive ints. */
const sizeRanges:Readonly<Record<string,Range>>=Object.freeze({iw:[1,int32],ih:[1,int32]});
const unsupported=():never=>{throw new VideoFilterParseError('Unsupported addroi expression: only numbers, the declared constants, + - * / and parentheses are implemented');};
/** Interval bound of an eval.c parse_subexpr/parse_term/parse_factor expression over numbers and the named ranges. The identity role has
 * no size hook, so parse proves instead that no link size gives NaN: every endpoint stays finite and no divisor range contains zero.
 * Round-to-nearest is monotone, so each evaluated value lies within the endpoints computed with the same operations. */
export function addroiExpressionRange(text:string,names:Readonly<Record<string,Range>>):Range{
 const s=text.replace(space,'');let at=0;
 const finite=(r:Range):Range=>Number.isFinite(r[0])&&Number.isFinite(r[1])?r:unsupported();
 const corners=(a:Range,b:Range,op:(p:number,q:number)=>number):Range=>{const v=[op(a[0],b[0]),op(a[0],b[1]),op(a[1],b[0]),op(a[1],b[1])];return finite([Math.min(...v),Math.max(...v)]);};
 const primary=():Range=>{
  if(s[at]==='('){at++;const r=sum();if(s[at]!==')')unsupported();at++;return r;}
  // av_strtod: decimal strtod only; hex, inf, nan and SI suffixes are refused.
  const number=/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(at));
  if(number){at+=number[0].length;if(/^[A-Za-z0-9_.]/.test(s.slice(at)))unsupported();const v=Number(number[0]);return finite([v,v]);}
  const name=/^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(at));if(!name||!Object.hasOwn(names,name[0]))return unsupported();at+=name[0].length;return names[name[0]]!;
 };
 const factor=():Range=>{const negative=s[at]==='-';if(negative||s[at]==='+')at++;const r=primary();if(s[at]==='^')unsupported();return negative?[-r[1],-r[0]]:r;};
 const term=():Range=>{let r=factor();while(s[at]==='*'||s[at]==='/'){const divide=s[at++]==='/',d=factor();if(divide&&d[0]<=0&&d[1]>=0)unsupported();r=corners(r,d,divide?(p,q)=>p/q:(p,q)=>p*q);}return r;};
 // parse_subexpr leaves the sign to the next factor: a-b is a+(-b).
 function sum():Range{let r=term();while(s[at]==='+'||s[at]==='-'){const d=term();r=finite([r[0]+d[0],r[1]+d[1]]);}return r;}
 const r=sum();if(at!==s.length)unsupported();return r;
}
/** addroi_init: av_expr_parse with iw and ih (the shared evaluator bounds apply), then the NaN-free subset. */
function regionExpression(key:string,text:string):string{
 try{compileExpression(text,{numericProfile:profile,constants:['iw','ih']});}catch(error){throw new VideoFilterParseError(`Invalid addroi ${key} expression: ${(error as Error).message}`);}
 addroiExpressionRange(text,sizeRanges);return text;
}
const qoffsetConstants={default:-0.1,max:1,min:-1,none:0,all:-1} as const;
const outside=(num:number,den:number)=>den===0||1*den<num||-1*den>num;
/** set_string_number for AV_OPT_TYPE_RATIONAL in [-1,1]: sscanf("%d%*1[:/]%d%c")==2 first, then the option expression and write_number. */
export function parseAddroiQoffset(value:string):{readonly num:number;readonly den:number}{
 const ratio=/^[ \t\n\v\f\r]*([+-]?\d+)[:/][ \t\n\v\f\r]*([+-]?\d+)$/.exec(value);
 if(ratio){
  const num=Number(ratio[1]),den=Number(ratio[2]);
  // glibc %d narrows a saturated long; ratios outside int are refused rather than narrowed.
  if([num,den].some(term=>term< -int32-1||term>int32))throw new VideoFilterParseError('Unsupported addroi qoffset: ratio terms outside int');
  if(!outside(num,den))return Object.freeze({num,den});
 }
 let d:number;
 try{d=compileExpression(value,{numericProfile:profile,constants:Object.keys(qoffsetConstants)})(Float64Array.from(Object.values(qoffsetConstants)));}catch(error){throw new VideoFilterParseError(`Invalid addroi qoffset: ${(error as Error).message}`);}
 // av_expr_parse_and_eval answers EINVAL for NaN; write_number answers ERANGE outside [-1,1], infinities included.
 if(Number.isNaN(d))throw new VideoFilterParseError('Invalid addroi qoffset: NaN');
 if(outside(d,1))throw new VideoFilterParseError('Invalid addroi qoffset: value outside [-1,1]');
 // An accepted value outside the arithmetic subset could come from unported functions, so it is refused.
 addroiExpressionRange(value,Object.fromEntries(Object.entries(qoffsetConstants).map(([key,v])=>[key,[v,v] as const])));
 if(Math.trunc(d)===d)return Object.freeze({num:d||0,den:1});
 // double_to_rational: av_d2q(d,1<<24), then INT_MAX when that gives a zero term.
 let r=numberToBoundedRational(d,1<<24);if(r.num===0n||r.den===0n)r=numberToBoundedRational(d,int32);return Object.freeze({num:Number(r.num),den:Number(r.den)});
}
export function parseAddroiOptions(options:string|null):AddroiStep{
 const values={x:'0',y:'0',w:'0',h:'0'};let qoffset:{readonly num:number;readonly den:number}={num:-1,den:10},clear=false;
 for(const option of filterOptions(options,['x','y','w','h','qoffset','clear'])){
  if(option.key==='x'||option.key==='y'||option.key==='w'||option.key==='h')values[option.key]=option.value;
  else if(option.key==='qoffset')qoffset=parseAddroiQoffset(option.value);
  else if(option.key==='clear'){try{clear=filterBoolean(option.value);}catch(error){throw new VideoFilterParseError(`Invalid addroi clear: ${(error as Error).message}`);}}
  else if(option.key==='enable')throw new VideoFilterParseError('Addroi has no timeline support');
  else throw new VideoFilterParseError('Unsupported addroi option');
 }
 for(const key of regionNames)regionExpression(key,values[key]);
 return Object.freeze({name:'addroi',...values,qoffset,clear});
}
/** addroi_config_input: x, y, w, h in order, each clamped to [0,max] and truncated to int, w and h bounded by the clamped x and y.
 * The region only feeds the side data, so no path calls this; it documents and tests the native values. */
export function addroiRegion(step:AddroiStep,width:number,height:number):AddroiRegion{
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>int32||height>int32)throw new Error('Invalid addroi input size');
 const region={x:0,y:0,w:0,h:0},vars=Float64Array.of(width,height);
 for(const key of regionNames){
  const max=key==='x'?width:key==='y'?height:key==='w'?width-region.x:height-region.y,val=compileExpression(regionExpression(key,step[key]),{numericProfile:profile,constants:['iw','ih']})(vars);
  if(Number.isNaN(val))throw new Error('Addroi expression evaluated to NaN');
  region[key]=val<0?0:val>max?max:Math.trunc(val)||0;
 }
 return Object.freeze(region);
}
/** Native is AVFILTER_FLAG_METADATA_ONLY without query_formats: every table format passes unchanged. enable= and runtime commands are
 * refused: no timeline flag, no process_command. */
export const addroiOperator=defineVideoOperator<AddroiStep>({name:'addroi',role:'identity',paths:['linear','graph','stream','actor','timed'],examples:['addroi=0:0:iw/2:ih/2:-1/5','addroi=x=iw/4:w=iw*2:qoffset=1,hflip','addroi=clear=1,addroi=1:2:3:4:qoffset=0','format=nv12,addroi,vflip'],
 parse:token=>singlePad(parseAddroiOptions(token.options))});
