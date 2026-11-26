// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_convolution.c and convolution.h (sobel, prewitt, scharr, roberts). See ../NOTICE-SOBEL.
import {compileExpression,pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
import {filterIntegerOption} from './activation/integer-option.js';
import {VideoFilterParseError} from './video-ops/descriptor.js';
import type {VideoFrameOptions} from './video-ops/descriptor.js';
import {executableFormat} from './video-ops/formats.js';
export class VideoGradientError extends Error {}
export type GradientName='sobel'|'prewitt'|'scharr'|'roberts';
/** common_options: planes (INT 0..15), scale and delta (AV_OPT_TYPE_FLOAT, stored rounded to float). */
export type GradientStep<N extends GradientName=GradientName>={readonly name:N;readonly planes:number;readonly scale:number;readonly delta:number};
export const gradientNames:readonly GradientName[]=Object.freeze(['sobel','prewitt','scharr','roberts']);
/** The pinned vf_convolution.c pix_fmts in declared order (native-endian names). A negotiated format without frame storage here is refused by name. */
export const gradientPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
const executable:readonly string[]=Object.freeze(gradientPixelFormats.filter(executableFormat));
const keys=['planes','scale','delta'];
/** AV_OPT_TYPE_FLOAT through set_string_number: an expression with default/max/min/none/all, range-checked as a double, then stored as float. */
function floatOption(expression:string,min:number,max:number,defaultValue:number):number{
 const constants={default:defaultValue,max,min,none:0,all:-1},value=compileExpression(expression,{numericProfile:'linux-x64',constants:Object.keys(constants)})(Float64Array.from(Object.values(constants)));
 // NaN passes native's range check; it is refused here rather than mirrored.
 if(!Number.isFinite(value)||value<min||value>max)throw new Error('Float filter option outside range');
 return Math.fround(value);
}
export function parseGradientOptions<N extends GradientName>(name:N,options:string|null):GradientStep<N>{
 if(!gradientNames.includes(name))throw new VideoGradientError('Invalid gradient operator');
 let planes=15,scale=1,delta=0;
 for(const option of filterOptions(options,keys)){
  try{
   if(option.key==='planes')planes=filterIntegerOption(option.value,{min:0,max:15,defaultValue:15});
   else if(option.key==='scale')scale=floatOption(option.value,0,65535,1);
   else if(option.key==='delta')delta=floatOption(option.value,-65535,65535,0);
   else if(option.key==='enable')throw new VideoFilterParseError(`${name[0]!.toUpperCase()+name.slice(1)} timeline expressions are not implemented`);
   else throw new VideoFilterParseError(`Unsupported ${name} option`);
  }catch(error){if(error instanceof VideoFilterParseError)throw error;throw new VideoFilterParseError(`Invalid ${name} ${option.key}: ${(error as Error).message}`);}
 }
 return Object.freeze({name,planes,scale,delta});
}
const checkStep=(step:GradientStep)=>{if(!gradientNames.includes(step?.name)||!Number.isInteger(step.planes)||step.planes<0||step.planes>15||!Number.isFinite(step.scale)||Math.fround(step.scale)!==step.scale||step.scale<0||step.scale>65535||!Number.isFinite(step.delta)||Math.fround(step.delta)!==step.delta||step.delta<-65535||step.delta>65535)throw new VideoGradientError('Invalid gradient settings');};
const f=Math.fround;
/** filter_sobel/prewitt/scharr/roberts: integer sums converted to float, then sqrtf(a*a+b*b)*scale+delta unfused with float rounding
 * after every operation (the x86-64 baseline), and av_clip_uint8 of the truncated int. */
function magnitude(a:number,b:number,scale:number,delta:number):number{
 const value=Math.trunc(f(f(f(Math.sqrt(f(f(a*a)+f(b*b))))*scale)+delta));
 return value<0?0:value>255?255:value;
}
/** filter_slice with setup_3x3 (avpriv_mirror borders) into owned tight planes; planes outside the mask are copied. */
export function gradientVideoFrame(frame:VideoFrameData,step:GradientStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);if(!executable.includes(layout.pixelFormat))throw new VideoGradientError(`${step.name} pixel format is not supported`);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoGradientError(`${step.name} frame exceeds allocation limit`);
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoGradientError(`Invalid ${step.name} plane count`);
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoGradientError(`Invalid ${step.name} plane stride or storage`);
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoGradientError(`${step.name} input plane storage exceeds allocation limit`);
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoGradientError(`Invalid ${step.name} timestamp time base`);
 const data=new Uint8Array(layout.bytes),{name,scale,delta}=step;
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,{width,height}=plane;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const row=y*stride,target=plane.offset+y*width;
   if(!(step.planes>>index&1)){data.set(src.subarray(row,row+width),target);continue;}
   // avpriv_mirror(y-1,h-1) and avpriv_mirror(y+1,h-1): a single row mirrors onto itself.
   const up=height<2?row:y>0?row-stride:row+stride,down=height<2?row:y<height-1?row+stride:row-stride;
   for(let x=0;x<width;x++){
    if((x&16383)===16383)signal?.throwIfAborted();
    const l=width<2?x:x>0?x-1:1,r=width<2?x:x<width-1?x+1:width-2;
    const c0=src[up+l]!,c1=src[up+x]!,c3=src[row+l]!,c4=src[row+x]!;let a:number,b:number;
    if(name==='roberts'){a=c0-c1;b=c4-c3;}
    else{
     const c2=src[up+r]!,c5=src[row+r]!,c6=src[down+l]!,c7=src[down+x]!,c8=src[down+r]!;
     if(name==='sobel'){a=-c0-2*c1-c2+c6+2*c7+c8;b=-c0+c2-2*c3+2*c5-c6+c8;}
     else if(name==='prewitt'){a=-c0-c1-c2+c6+c7+c8;b=-c0+c2-c3+c5-c6+c8;}
     // suma /= 256.f and sumb /= 256.f: exact power-of-two divisions of exactly representable integers.
     else{a=(-47*c0-162*c1-47*c2+47*c6+162*c7+47*c8)/256;b=(-47*c0+47*c2-162*c3+162*c5-47*c6+47*c8)/256;}
    }
    data[target+x]=magnitude(a,b,scale,delta);
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
