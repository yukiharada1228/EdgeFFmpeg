// SPDX-License-Identifier: LGPL-2.1-or-later
// Component, plane and option semantics adapted from pinned FFmpeg libavfilter/vf_negate.c
// and libavutil/opt.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
export class VideoNegateError extends Error {}
export interface VideoNegateSettings {readonly components:number;readonly negateAlpha:boolean}
export interface VideoNegateOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** Pinned negate pix_fmts restricted to the declared eight-bit layouts; semiplanar input needs conversion. */
export const negatePixelFormats:readonly string[]=Object.freeze(['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','argb','rgba','abgr','bgra','yuva420p','gbrp']);
const DEFAULT=0x77,constants:Readonly<Record<string,number>>={y:0x10,u:0x20,v:0x40,r:0x01,g:0x02,b:0x04,a:0x08,default:DEFAULT,max:0xff,min:1,none:0,all:-1};
// rgba_map component offsets from ff_fill_rgba_map for packed RGB.
const packedMaps:Readonly<Record<string,readonly [number,number,number,number]>>={rgb24:[0,1,2,-1],bgr24:[2,1,0,-1],rgba:[0,1,2,3],bgra:[2,1,0,3],argb:[1,2,3,0],abgr:[3,2,1,0]};
/** AV_OPT_TYPE_FLAGS terms: declared names or av_strtod decimal/0x integers, folded left from the current value. */
function negateComponents(value:string,current:number):number{
 if(value===''||value.length>255)throw new VideoNegateError('Only bounded nonempty negate component flags are implemented');
 let position=0;
 for(;;){
  let command='';if(value[position]==='+'||value[position]==='-')command=value[position++]!;
  let end=position;while(end<value.length&&value[end]!=='+'&&value[end]!=='-')end++;
  const term=value.slice(position,end),named=Object.hasOwn(constants,term)?constants[term]!:/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(term)?Number(term):NaN;
  // Larger terms make the native int64 flag cast platform dependent.
  if(!Number.isSafeInteger(named)||named>0xffffffff)throw new VideoNegateError('Only declared negate component names and integer flags up to 4294967295 are implemented');
  const intnum=current>>>0,d=command==='+'?Number(BigInt(intnum)|BigInt(named)):command==='-'?Number(BigInt(intnum)&~BigInt(named)):named;
  if(d< -1.5||d>0xffffffff+0.5)throw new VideoNegateError('Negate components are not a valid set of 32bit integer flags');
  current=d|0;position=end;if(position>=value.length)return current;
 }
}
// LP64 strtol followed by signed32 narrowing, as used by pinned AV_OPT_TYPE_BOOL.
function negateBoolean(value:string):boolean{
 const lower=value.toLowerCase();if(['true','y','yes','enable','enabled','on'].includes(lower))return true;if(['false','n','no','disable','disabled','off'].includes(lower))return false;
 if(value==='')return false;if(!/^[ \t\n\r\v\f]*[+-]?\d+$/.test(value))throw new VideoNegateError('Invalid negate_alpha boolean');let n=BigInt(value.trim());n=n<-(1n<<63n)?-(1n<<63n):n>(1n<<63n)-1n?(1n<<63n)-1n:n;const narrowed=BigInt.asIntN(32,n);if(narrowed!==0n&&narrowed!==1n)throw new VideoNegateError('negate_alpha outside range');return narrowed===1n;
}
export function parseNegateOptions(options:string|null):VideoNegateSettings{
 let components=DEFAULT,negateAlpha=false;
 for(const option of filterOptions(options,['components','negate_alpha'])){
  if(option.key==='components')components=negateComponents(option.value,components);
  else if(option.key==='negate_alpha')negateAlpha=negateBoolean(option.value);
  else if(option.key==='enable')throw new VideoNegateError('Negate timeline expressions are not implemented');
  else throw new VideoNegateError('Unsupported negate option');
 }
 return Object.freeze({components,negateAlpha});
}
/** config_input: plane mask for planar layouts or byte-position mask for packed RGB. */
export function negateMasks(pixelFormat:string,settings:VideoNegateSettings):{readonly planes:number;readonly packed:number|null}{
 const format=pixelLayout(pixelFormat,1,1).pixelFormat;if(!negatePixelFormats.includes(format))throw new VideoNegateError('Negate pixel format is not supported');
 const {components,negateAlpha}=settings;if(!Number.isInteger(components)||components< -2147483648||components>2147483647||typeof negateAlpha!=='boolean')throw new VideoNegateError('Invalid negate settings');
 const rgb=['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'].includes(format),alpha=['rgba','bgra','argb','abgr','yuva420p'].includes(format),chroma=format!=='gray';
 let planes=negateAlpha?0xf:0x7;
 if(components!==DEFAULT){
  const available=(rgb?0x07:0x10|(chroma?0x60:0))|(alpha?0x08:0);if(components&~available)throw new VideoNegateError('Requested components not available');
  planes=rgb?(components&0x01?4:0)|(components&0x02?1:0)|(components&0x04?2:0)|(components&0x08?8:0):(components&0x10?1:0)|(components&0x20?2:0)|(components&0x40?4:0)|(components&0x08?8:0);
 }
 const map=packedMaps[format];if(!map)return Object.freeze({planes,packed:null});
 let packed=0;for(const [index,bit]of [0x01,0x02,0x04,0x08].entries())if(components&bit&&map[index]!>=0)packed|=1<<map[index]!;
 return Object.freeze({planes:1,packed});
}
/** Materialize an eight-bit negation into owned tight planes with positive strides. */
export function negateVideoFrame(frame:VideoFrameData,settings:VideoNegateSettings,options:VideoNegateOptions):VideoFrameData {
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),{planes,packed}=negateMasks(layout.pixelFormat,settings);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoNegateError('Negate frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoNegateError('Invalid negate plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoNegateError('Invalid negate plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoNegateError('Negate input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoNegateError('Invalid negate timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,step=plane.rowBytes/plane.width,masks=Array.from({length:step},(_,component)=>packed===null?(planes>>index&1?255:0):(packed>>component&1?255:0));
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const sourceRow=y*stride,targetRow=plane.offset+y*plane.rowBytes;
   if(!masks.some(mask=>mask)){data.set(input.subarray(sourceRow,sourceRow+plane.rowBytes),targetRow);continue;}
   for(let x=0;x<plane.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();data[targetRow+x]=input[sourceRow+x]!^masks[x%step]!;}
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
