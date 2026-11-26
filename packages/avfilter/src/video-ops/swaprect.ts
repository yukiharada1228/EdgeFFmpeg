// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_swaprect.c (swaprect_options, query_formats, filter_frame, config_input). See ../../NOTICE-SWAPRECT.
import {compileExpression,evaluateExpression,pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions,VideoShape} from './descriptor.js';
import {negotiableFormats,executableFormat} from './formats.js';
export class VideoSwaprectError extends Error {}
const keys=['w','h','x1','y1','x2','y2'] as const;
type Key=typeof keys[number];
export type SwaprectStep={readonly name:'swaprect';readonly w:string;readonly h:string;readonly x1:string;readonly y1:string;readonly x2:string;readonly y2:string};
/** var_names in declared order. n (frame_count_out) is refused: no path carries the link frame counter. sar and dar are refused: the
 * frame-graph shapes do not carry the link sample aspect ratio and the timed executor runs the unnegotiated step. */
const variables=['w','h','a','n','t','sar','dar'] as const;
const profile={numericProfile:'linux-x64' as const};
/** ff_formats_pixdesc_filter(0, PAL|HWACCEL|BITSTREAM) in AVPixelFormat order: the negotiation table (already without hwaccel)
 * minus the palette and bitstream descriptors of the pinned build. A negotiated format outside the executable table is refused at plan time. */
const rejected=new Set(['monow','monob','pal8','bgr4','rgb4','xv30be','v30xbe']);
const formats=Object.freeze(negotiableFormats.filter(format=>!rejected.has(format)));
/** log2_chroma_w, log2_chroma_h and av_image_fill_max_pixsteps of the members with frame storage here. */
const traits:Readonly<Record<string,{readonly cw:number;readonly ch:number;readonly steps:readonly number[]}>>={
 yuv420p:{cw:1,ch:1,steps:[1,1,1]},yuv422p:{cw:1,ch:0,steps:[1,1,1]},yuv444p:{cw:0,ch:0,steps:[1,1,1]},gray:{cw:0,ch:0,steps:[1]},gbrp:{cw:0,ch:0,steps:[1,1,1]},yuva420p:{cw:1,ch:1,steps:[1,1,1,1]},
 nv12:{cw:1,ch:1,steps:[1,2]},nv21:{cw:1,ch:1,steps:[1,2]},rgb24:{cw:0,ch:0,steps:[3]},bgr24:{cw:0,ch:0,steps:[3]},argb:{cw:0,ch:0,steps:[4]},rgba:{cw:0,ch:0,steps:[4]},abgr:{cw:0,ch:0,steps:[4]},bgra:{cw:0,ch:0,steps:[4]},
};
/** Functions whose results are JavaScript Math here and not the reference libm; ^ is pow. time is the wall clock. */
const unported=/(?<![A-Za-z0-9_])(?:sinh|cosh|tanh|sin|cos|tan|asin|acos|atan2|atan|exp|pow|gauss|squish|time)\(/;
/** Parses without evaluating. */
const compiles=(expression:string,names:readonly string[])=>{try{compileExpression(expression,{...profile,constants:names});return true;}catch{return false;}};
/** The variables an expression reads: removing a name from the table makes its parse fail exactly when the expression reads it. */
function uses(expression:string):ReadonlySet<string>{
 const used=new Set<string>();for(const name of variables)if(!compiles(expression,variables.filter(other=>other!==name)))used.add(name);return used;
}
function checkExpression(key:Key,expression:string):void{
 if(!compiles(expression,variables))throw new VideoFilterParseError(`Invalid swaprect ${key} expression`);
 const text=expression.replace(/[ \t\n\r\v\f]/g,'');
 if(text.includes('^')||unported.test(text))throw new VideoFilterParseError(`Swaprect ${key} expressions calling functions whose libm results are not reproduced are not implemented`);
 const used=uses(expression);
 if(used.has('n'))throw new VideoFilterParseError(`Swaprect ${key} expressions reading n are not implemented`);
 if(used.has('sar')||used.has('dar'))throw new VideoFilterParseError(`Swaprect ${key} expressions reading sar or dar are not implemented`);
}
export function parseSwaprectOptions(options:string|null):SwaprectStep{
 const values:Record<Key,string>={w:'w/2',h:'h/2',x1:'w/2',y1:'h/2',x2:'0',y2:'0'};
 for(const option of filterOptions(options,keys)){
  if(option.key==='enable')throw new VideoFilterParseError('Swaprect timeline expressions are not implemented');
  if(!(keys as readonly string[]).includes(option.key))throw new VideoFilterParseError('Unsupported swaprect option');
  values[option.key as Key]=option.value;
 }
 for(const key of keys)checkExpression(key,values[key]);
 return Object.freeze({name:'swaprect',...values});
}
const readsTime=(step:SwaprectStep)=>keys.some(key=>uses(step[key]).has('t'));
/** double to int: C truncation; NaN and values outside int are undefined behaviour natively and refused. */
const integer=(value:number,key:Key)=>{if(!Number.isFinite(value)||value<=-2147483649||value>=2147483648)throw new VideoSwaprectError(`Swaprect ${key} evaluates to ${value}, outside int`);const n=Math.trunc(value);if(n===-2147483648&&(key==='w'||key==='h'))throw new VideoSwaprectError(`Swaprect ${key} evaluates to ${n}, which overflows AV_CEIL_RSHIFT`);return n;};
const clip=(value:number,low:number,high:number)=>value<low?low:value>high?high:value;
/** AV_CEIL_RSHIFT with a variable shift. */
const ceilShift=(value:number,shift:number)=>-(-value>>shift);
export interface SwaprectPlane {readonly plane:number;readonly x1:number;readonly y1:number;readonly x2:number;readonly y2:number;readonly width:number;readonly height:number;readonly step:number}
/** filter_frame's evaluation, clamping and subsampling rounding: the planes it swaps (pw and ph equal to the unclamped aw and ah). */
export function swaprectPlanes(step:SwaprectStep,format:string,width:number,height:number,pts:VideoFrameData['pts']):readonly SwaprectPlane[]{
 const trait=traits[format];if(!trait)throw new VideoSwaprectError('Swaprect pixel format is not supported');
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>2147483647||height>2147483647)throw new VideoSwaprectError('Invalid swaprect frame size');
 const a=Math.fround(Math.fround(width)/height),t=pts===null?NaN:Number(pts.value)*(Number(pts.timeBase.num)/Number(pts.timeBase.den));
 const values=[width,height,a,NaN,t,NaN,NaN],evaluated=Object.fromEntries(keys.map(key=>{let value:number;try{value=evaluateExpression(step[key],{...profile,constants:variables},values);}catch(error){throw new VideoSwaprectError(`Swaprect ${key} evaluation failed: ${error instanceof Error?error.message:String(error)}`);}return [key,integer(value,key)];})) as Record<Key,number>;
 let w=evaluated.w,h=evaluated.h;const x1=clip(evaluated.x1,0,width-1),y1=clip(evaluated.y1,0,height-1),x2=clip(evaluated.x2,0,width-1),y2=clip(evaluated.y2,0,height-1);
 const aw=[w,ceilShift(w,trait.cw),ceilShift(w,trait.cw),w],ah=[h,ceilShift(h,trait.ch),ceilShift(h,trait.ch),h];
 w=Math.min(w,width-x1,width-x2);h=Math.min(h,height-y1,height-y2);
 const pw=[w,ceilShift(w,trait.cw),ceilShift(w,trait.cw),w],ph=[h,ceilShift(h,trait.ch),ceilShift(h,trait.ch),h],planes:SwaprectPlane[]=[];
 for(let p=0;p<trait.steps.length;p++){
  if(ph[p]!==ah[p]||pw[p]!==aw[p]||ph[p]!<=0||pw[p]===0)continue;
  // memcpy with a negative size: native reads and writes far outside the frame.
  if(pw[p]!<0)throw new VideoSwaprectError('Swaprect negative widths with positive heights are not implemented: native copies a negative size');
  const sx=p===1||p===2?trait.cw:0,sy=p===1||p===2?trait.ch:0;
  planes.push({plane:p,x1:x1>>sx,y1:y1>>sy,x2:x2>>sx,y2:y2>>sy,width:pw[p]!,height:ph[p]!,step:trait.steps[p]!});
 }
 return planes;
}
/** Plan-time checks: time-independent expressions are evaluated once with the negotiated geometry. */
function check(step:SwaprectStep,input:VideoShape):void{if(executableFormat(input.format)&&!readsTime(step))swaprectPlanes(step,input.format,input.width,input.height,null);}
/** NEEDS_WRITABLE then in-place row swaps (memcpy to temp, memmove, memcpy back), materialized into owned tight planes. */
export function swaprectVideoFrame(frame:VideoFrameData,step:SwaprectStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(!traits[frame.pixelFormat])throw new VideoSwaprectError('Swaprect pixel format is not supported');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoSwaprectError('Swaprect frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoSwaprectError('Invalid swaprect plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoSwaprectError('Invalid swaprect plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoSwaprectError('Swaprect input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoSwaprectError('Invalid swaprect timestamp time base');
 const swaps=swaprectPlanes(step,frame.pixelFormat,frame.width,frame.height,frame.pts),data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!;
  for(let y=0;y<plane.height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 }
 for(const swap of swaps){
  const plane=layout.planes[swap.plane]!,stride=plane.rowBytes,bytes=swap.width*swap.step;let src=plane.offset+swap.y1*stride+swap.x1*swap.step,dst=plane.offset+swap.y2*stride+swap.x2*swap.step;
  for(let y=0;y<swap.height;y++){signal?.throwIfAborted();const temp=data.slice(src,src+bytes);data.copyWithin(src,dst,dst+bytes);data.set(temp,dst);src+=stride;dst+=stride;}
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** geometry runs only in the linear and frame-graph negotiators, whose CLI paths hand the filter timestamps that differ from native
 * under input or output -ss; timedGeometry runs for the actor and timed paths, which deliver native filter timestamps. */
export const swaprectOperator=defineVideoOperator<SwaprectStep>({name:'swaprect',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['swaprect','swaprect=2:3:0:0:5:4,hflip','swaprect=w=w/4+1:h=3:x1=a*2:y1=1:x2=w-3:y2=h-3'],
 parse:token=>singlePad(parseSwaprectOptions(token.options)),
 formats:()=>formats,
 geometry:(step,[input])=>{if(readsTime(step))throw new VideoSwaprectError('Swaprect t expressions are implemented on the actor and timed paths only');check(step,input!);return {width:input!.width,height:input!.height};},
 timedGeometry:(step,{input})=>{check(step,input);return {width:input.width,height:input.height,sampleAspectRatio:input.sampleAspectRatio};},
 frame:(frame,step,options)=>swaprectVideoFrame(frame,step,options)});
