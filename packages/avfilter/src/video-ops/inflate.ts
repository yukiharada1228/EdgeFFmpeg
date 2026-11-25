// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_neighbor.c (inflate) and libavutil/opt.c. See ../../NOTICE-INFLATE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterIntegerOption} from '../activation/integer-option.js';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoInflateError extends Error {}
export type InflateStep={readonly name:'inflate';readonly thresholds:readonly [number,number,number,number]};
/** The pinned vf_neighbor.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * A negotiated format outside the executable table is refused at plan time. */
const formats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit planar members with frame storage here. */
const executable:readonly string[]=Object.freeze(formats.filter(executableFormat));
const shorthand=['threshold0','threshold1','threshold2','threshold3'] as const,generic=['threads','thread_type','extra_hw_frames'];
/** deflate_inflate class: threshold0..3 AV_OPT_TYPE_INT in [0,65535], default 65535, in shorthand order. */
export function parseInflateOptions(options:string|null):InflateStep{
 const thresholds:[number,number,number,number]=[65535,65535,65535,65535];
 for(const option of filterOptions(options,shorthand)){
  const plane=shorthand.indexOf(option.key as typeof shorthand[number]);
  // Generic AVFilterContext options exist natively but are not implemented here; anything else is unknown to native too.
  if(plane<0)throw new VideoFilterParseError(option.key==='enable'?'Inflate timeline expressions are not implemented':generic.includes(option.key)?`Inflate option ${option.key} is not implemented`:`Error applying option '${option.key}' to filter 'inflate': Option not found`);
  try{thresholds[plane]=filterIntegerOption(option.value,{min:0,max:65535,defaultValue:65535});}catch(error){throw new VideoFilterParseError(`Error applying option '${option.key}' to filter 'inflate': ${error instanceof Error&&error.message==='Integer filter option outside range'?'Numerical result out of range':'Invalid argument'}`);}
 }
 return Object.freeze({name:'inflate',thresholds:Object.freeze(thresholds)});
}
/** A filtered width-1 plane makes native read past the row (coordinateslb), so it is refused; threshold 0 planes are copied. */
function inflateLayout(pixelFormat:string,width:number,height:number,step:InflateStep){
 const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoInflateError('Inflate pixel format is not supported');
 if(!Array.isArray(step.thresholds)||step.thresholds.length!==4||step.thresholds.some(value=>!Number.isInteger(value)||value<0||value>65535))throw new VideoInflateError('Invalid inflate settings');
 for(const [index,plane]of layout.planes.entries())if(plane.width<2&&step.thresholds[index])throw new VideoInflateError('Inflate needs filtered planes at least two pixels wide');
 return layout;
}
/** Materialize inflate into owned tight planes: dst = min(max(sum8/8, p), min(p + threshold, 255)) with native mirrored borders. */
export function inflateVideoFrame(frame:VideoFrameData,step:InflateStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=inflateLayout(frame.pixelFormat,frame.width,frame.height,step);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoInflateError('Inflate frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoInflateError('Invalid inflate plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoInflateError('Invalid inflate plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoInflateError('Inflate input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoInflateError('Invalid inflate timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,threshold=step.thresholds[index]!,{width,height}=plane;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const row=y*stride,up=row-(y>0?stride:0),down=row+(y<height-1?stride:0),target=plane.offset+y*width;
   if(!threshold){data.set(input.subarray(row,row+width),target);continue;}
   for(let x=0;x<width;x++){
    if((x&16383)===16383)signal?.throwIfAborted();
    const l=x>0?x-1:1,r=x<width-1?x+1:width-2,p=input[row+x]!;
    const sum=input[up+l]!+input[up+x]!+input[up+r]!+input[row+l]!+input[row+r]!+input[down+l]!+input[down+x]!+input[down+r]!;
    data[target+x]=Math.min(Math.max(sum>>3,p),Math.min(p+threshold,255));
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused; actor and timed run the stateless frame function. */
export const inflateOperator=defineVideoOperator<InflateStep>({name:'inflate',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['inflate','inflate=threshold0=12:threshold1=0','inflate=7,hflip'],
 parse:token=>singlePad(parseInflateOptions(token.options)),
 formats:()=>formats,
 geometry:(step,[input])=>{const layout=inflateLayout(input!.format,input!.width,input!.height,step);return {width:layout.width,height:layout.height};},
 frame:(frame,step,options)=>inflateVideoFrame(frame,step,options)});
