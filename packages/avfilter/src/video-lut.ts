// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_lut.c. See ../NOTICE-LUT.
import {compileExpression,pixelLayout} from '@edge-ffmpeg/avutil';
import type {ExpressionNumericProfile,VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
import {VideoFilterParseError} from './video-ops/descriptor.js';
import type {VideoFrameOptions,VideoShape,VideoSize} from './video-ops/descriptor.js';
import {executableFormat,storageFormat} from './video-ops/formats.js';
export class VideoLutError extends Error {}
export type LutName='lut'|'lutrgb'|'lutyuv';
/** comp_expr_str[0..3]: the expression of each component in descriptor order (R, G, B, A for RGB formats). */
export type LutFilterStep={readonly name:LutName;readonly expressions:readonly [string,string,string,string]};
/** The AVOption order; process_options skips an option whose offset equals the previous one, so all eleven are shorthand. */
const shorthand=['c0','c1','c2','c3','y','u','v','r','g','b','a'] as const;
const slot:Readonly<Record<string,number>>={c0:0,c1:1,c2:2,c3:3,y:0,u:1,v:2,r:0,g:1,b:2,a:3};
/** var_names in declared order: av_expr matches constants in this order. */
export const lutVariables=Object.freeze(['w','h','val','maxval','minval','negval','clipval']);
/** libavutil builtins whose value uses JavaScript Math here instead of a glibc reproduction, time() and root() (pow). */
const unported=new Set(['sin','cos','tan','asin','acos','atan','atan2','sinh','cosh','tanh','exp','pow','gauss','squish','time','root']);
const YUV='yuv444p yuv422p yuv420p yuv411p yuv410p yuv440p yuva420p yuva422p yuva444p yuvj444p yuvj422p yuvj420p yuvj440p yuv444p9le yuv422p9le yuv420p9le yuv444p10le yuv422p10le yuv420p10le yuv440p10le yuv444p12le yuv422p12le yuv420p12le yuv440p12le yuv444p14le yuv422p14le yuv420p14le yuv444p16le yuv422p16le yuv420p16le yuva444p16le yuva422p16le yuva420p16le'.split(' ');
const RGB='argb rgba abgr bgra rgb24 bgr24 rgb48le rgba64le gbrp gbrap gbrp9le gbrp10le gbrap10le gbrp12le gbrp14le gbrp16le gbrap12le gbrap16le'.split(' ');
const GRAY='gray gray9le gray10le gray12le gray14le gray16le'.split(' ');
/** yuv_pix_fmts, rgb_pix_fmts and all_pix_fmts (RGB, YUV then gray) in declared order (native-endian names). */
export const lutPixelFormats:Readonly<Record<LutName,readonly string[]>>=Object.freeze({lutyuv:Object.freeze(YUV),lutrgb:Object.freeze(RGB),lut:Object.freeze([...RGB,...YUV,...GRAY])});
/** ff_fill_rgba_map: the byte offset of R, G, B and A in each packed format with storage here. */
const packed:Readonly<Record<string,readonly number[]>>={rgb24:[0,1,2],bgr24:[2,1,0],rgba:[0,1,2,3],bgra:[2,1,0,3],argb:[1,2,3,0],abgr:[3,2,1,0]};
/** config_props' limited range of the yuv_pix_fmts cases with storage here; every other member uses 0..255. */
const limited=new Set(['yuv420p','yuv422p','yuv444p','yuva420p']);
const legacy:Readonly<Record<string,string>>={yuv420p:'yuvj420p',yuv422p:'yuvj422p',yuv444p:'yuvj444p'};
/** Refuses gammaval(), gammaval709(), unported builtins and the ^ operator (pow) anywhere in the expression. */
function checkLutExpression(expression:string):void{
 const text=expression.replace(/[ \t\n\r\v\f]/g,'');
 for(const match of text.matchAll(/[A-Za-z_][A-Za-z_0-9]*/g)){
  const name=match[0];
  if(name==='gammaval'||name==='gammaval709')throw new VideoFilterParseError('Lut gammaval() and gammaval709() are not implemented');
  if(unported.has(name))throw new VideoFilterParseError(`Lut expression function ${name}() is not implemented`);
 }
 if(text.includes('^'))throw new VideoFilterParseError('Lut expression operator ^ is not implemented');
}
/** AV_OPT_TYPE_STRING options applied in order (a later alias of the same component wins); enable= and unknown keys are refused.
 * Each expression is parsed in configure, for the components the negotiated format has, as config_props does. */
export function parseLutOptions(name:LutName,options:string|null):LutFilterStep{
 const expressions:[string,string,string,string]=['clipval','clipval','clipval','clipval'];
 for(const option of filterOptions(options,shorthand)){
  const index=Object.hasOwn(slot,option.key)?slot[option.key]:undefined;
  if(index!==undefined){checkLutExpression(option.value);expressions[index]=option.value;}
  else if(option.key==='enable')throw new VideoFilterParseError(`${name[0]!.toUpperCase()+name.slice(1)} timeline expressions are not implemented`);
  else throw new VideoFilterParseError(`Unsupported ${name} option`);
 }
 return Object.freeze({name,expressions:Object.freeze(expressions)});
}
/** Plane p of the negotiated layout reads table plane[p]; packed RGB byte offset o reads table offsets[o]. */
interface LutTables {readonly tables:readonly Uint8Array[]}
const cache=new WeakMap<LutFilterStep,Map<string,LutTables>>();
const components=(format:string)=>packed[format]?.length??pixelLayout(format,1,1).planes.length;
/** One 256 * 256 table per component as config_props builds it, with one compiled context per component and profile. */
function evaluateTable(step:LutFilterStep,color:number,min:number,max:number,width:number,height:number,profile:ExpressionNumericProfile):{used:Uint8Array;nan:boolean}{
 const expression=step.expressions[color]!;let evaluate;
 try{evaluate=compileExpression(expression,{numericProfile:profile,constants:lutVariables});}catch(error){throw new VideoLutError(`Invalid lut expression '${expression}' for component ${color}: ${(error as Error).message}`);}
 const values=new Float64Array([width,height,0,max,min,0,0]),used=new Uint8Array(256);
 for(let val=0;val<65536;val++){
  values[2]=val;values[6]=val<min?min:val>max?max:val;const negated=min+max-val;values[5]=negated<min?min:negated>max?max:negated;
  let result:number;try{result=evaluate(values);}catch(error){throw new VideoLutError(`Lut expression '${expression}' failed for the value ${val}: ${(error as Error).message}`);}
  if(Number.isNaN(result))return {used,nan:true};
  if(val<256){
   // (int)res: out-of-range conversions give INT_MIN on x86-64 and saturate on AArch64, so they are refused.
   if(!(result>-2147483649&&result<2147483648))throw new VideoLutError(`Lut expression '${expression}' gives a value outside the int range for the value ${val}`);
   const truncated=Math.trunc(result);used[val]=truncated<0?0:truncated>255?255:truncated;
  }
 }
 return {used,nan:false};
}
/** config_props for an 8-bit format with storage: the tables of every component it has. Both numeric profiles must agree.
 * Cached per step and format, and per size only when an expression names w or h. */
export function lutTables(step:LutFilterStep,format:string,width:number,height:number):readonly Uint8Array[]{
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw new VideoLutError('Invalid lut frame size');
 requireLutFormat(step,format);
 let byStep=cache.get(step);if(!byStep){byStep=new Map();cache.set(step,byStep);}
 const sized=step.expressions.some(expression=>/(?:^|[^A-Za-z_0-9])[wh](?![A-Za-z_0-9])/.test(expression)),key=sized?`${format}/${width}/${height}`:format,hit=byStep.get(key);if(hit)return hit.tables;
 const range=limited.has(format)?[[16,235],[16,240],[16,240],[0,255]]:[[0,255],[0,255],[0,255],[0,255]],tables:Uint8Array[]=[];
 for(let color=0;color<components(storageFormat(format));color++){
  const [min,max]=range[color]!,linux=evaluateTable(step,color,min!,max!,width,height,'linux-x64'),darwin=evaluateTable(step,color,min!,max!,width,height,'darwin-arm64');
  if(linux.nan)throw new VideoLutError(`Lut expression '${step.expressions[color]}' evaluates to NaN for component ${color}`);
  if(darwin.nan||linux.used.some((value,index)=>value!==darwin.used[index]))throw new VideoLutError(`Lut expression '${step.expressions[color]}' depends on the numeric profile`);
  tables.push(linux.used);
 }
 if(byStep.size>=8)byStep.clear();byStep.set(key,Object.freeze({tables}));
 return tables;
}
/** A member of the operator's list with frame storage here; a legacy yuvj link keeps its name, so config_props' full range applies to it. */
export function requireLutFormat(step:LutFilterStep,format:string):void{
 if(!executableFormat(storageFormat(format))||!lutPixelFormats[step.name].includes(format))throw new VideoLutError(`Lut pixel format ${format} is not supported`);
}
/** Size-preserving; builds (and so refuses) the tables against the negotiated input. Formats without storage are left to the negotiators' named refusal. */
export function lutGeometry(step:LutFilterStep,input:VideoShape):VideoSize{
 if(executableFormat(storageFormat(input.format)))lutTables(step,input.format,input.width,input.height);
 return {width:input.width,height:input.height};
}
/** lut_planar_8bits and lut_packed_8bits: every plane or packed component through its table. Owned tight planes. */
export function lutVideoFrame(frame:VideoFrameData,step:LutFilterStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(!step||!Array.isArray(step.expressions)||step.expressions.length!==4||step.expressions.some(expression=>typeof expression!=='string')||!Object.hasOwn(lutPixelFormats,step.name))throw new VideoLutError('Invalid lut settings');
 const layout=pixelLayout(storageFormat(frame.pixelFormat),frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoLutError('Lut frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoLutError('Invalid lut plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoLutError('Invalid lut plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoLutError('Lut input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoLutError('Invalid lut timestamp time base');
 // A legacy yuvj link reaches the operator as yuv storage tagged with the JPEG range: config_props then takes the full-range default case.
 const jpeg=frame.metadata.colorRange===2?legacy[layout.pixelFormat]:undefined,tables=lutTables(step,storageFormat(frame.pixelFormat)!==frame.pixelFormat?frame.pixelFormat:jpeg??layout.pixelFormat,frame.width,frame.height),map=packed[layout.pixelFormat],data=new Uint8Array(layout.bytes);
 // gbrp planes hold G, B, R: rgba_map sends component c to plane comp[c].plane, so plane p reads the table of that component.
 const planeTables=map?[]:layout.pixelFormat==='gbrp'?[tables[1]!,tables[2]!,tables[0]!]:tables;
 const offsetTables=map?map.map((_,offset)=>tables[map.indexOf(offset)]!):[];
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,table=planeTables[index];
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const source=y*stride,target=plane.offset+y*plane.rowBytes;
   if(table)for(let x=0;x<plane.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();data[target+x]=table[input[source+x]!]!;}
   else{const pixel=offsetTables.length;for(let x=0;x<plane.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();data[target+x]=offsetTables[x%pixel]![input[source+x]!]!;}}
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
