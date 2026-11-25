// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_neighbor.c (dilation) at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../../NOTICE-DILATION.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoDilationError extends Error {}
export type DilationStep={readonly name:'dilation';readonly coordinates:number;readonly thresholds:readonly [number,number,number,number]};
/** The pinned vf_neighbor.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * A negotiated format outside the executable table is refused at plan time. */
export const dilationPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit planar members with frame storage here. */
const executable:readonly string[]=Object.freeze(dilationPixelFormats.filter(executableFormat));
const keys=['coordinates','threshold0','threshold1','threshold2','threshold3'] as const;
/** Declared AVOptions in native order, which is also the shorthand order; enable= and every other option are refused. */
export function parseDilationOptions(options:string|null):DilationStep{
 let coordinates=255;const thresholds:[number,number,number,number]=[65535,65535,65535,65535];
 for(const option of filterOptions(options,keys)){
  if(option.key==='enable')throw new VideoFilterParseError('Dilation timeline expressions are not implemented');
  const index=(keys as readonly string[]).indexOf(option.key);if(index<0)throw new VideoFilterParseError('Unsupported dilation option');
  let value:number;try{value=filterIntegerOption(option.value,index?{min:0,max:65535,defaultValue:65535}:{min:0,max:255,defaultValue:255});}catch{throw new VideoFilterParseError(`Invalid dilation ${option.key}`);}
  if(index)thresholds[index-1]=value;else coordinates=value;
 }
 return Object.freeze({name:'dilation',coordinates,thresholds:Object.freeze(thresholds)});
}
/** Native reads past the row for width-1 planes (coordinateslb), so those configurations are refused. */
function dilationLayout(pixelFormat:string,width:number,height:number){
 const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoDilationError('Dilation pixel format is not supported');
 if(layout.planes.some(plane=>plane.width<2))throw new VideoDilationError('Dilation planes narrower than 2 pixels are not implemented');return layout;
}
function validStep(step:DilationStep):void{
 if(!Number.isInteger(step.coordinates)||step.coordinates<0||step.coordinates>255||step.thresholds.length!==4||step.thresholds.some(value=>!Number.isInteger(value)||value<0||value>65535))throw new VideoDilationError('Invalid dilation settings');
}
/** filter_slice with the dilation kernel: lb/rb column reflection, nh/ph row clamps, threshold=0 copies the plane. */
export function dilateVideoFrame(frame:VideoFrameData,step:DilationStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();validStep(step);
 const layout=dilationLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoDilationError('Dilation frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoDilationError('Invalid dilation plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoDilationError('Invalid dilation plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoDilationError('Dilation input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoDilationError('Invalid dilation timestamp time base');
 const data=new Uint8Array(layout.bytes),coord=step.coordinates;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,threshold=step.thresholds[index]!,width=plane.width,height=plane.height;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const row=y*stride,up=row-(y>0?stride:0),down=row+(y<height-1?stride:0),target=plane.offset+y*width;
   if(!threshold){data.set(input.subarray(row,row+width),target);continue;}
   for(let x=0;x<width;x++){
    if((x&16383)===16383)signal?.throwIfAborted();
    const l=x>0?x-1:1,r=x<width-1?x+1:width-2,p=input[row+x]!,limit=Math.min(p+threshold,255);let max=p;
    if(coord&1)max=Math.max(max,input[up+l]!);if(coord&2)max=Math.max(max,input[up+x]!);if(coord&4)max=Math.max(max,input[up+r]!);
    if(coord&8)max=Math.max(max,input[row+l]!);if(coord&16)max=Math.max(max,input[row+r]!);
    if(coord&32)max=Math.max(max,input[down+l]!);if(coord&64)max=Math.max(max,input[down+x]!);if(coord&128)max=Math.max(max,input[down+r]!);
    data[target+x]=Math.min(max,limit);
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
export const dilationOperator=defineVideoOperator<DilationStep>({name:'dilation',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['dilation','dilation=coordinates=90:threshold0=12,hflip','dilation=15:0'],
 parse:token=>singlePad(parseDilationOptions(token.options)),
 formats:()=>dilationPixelFormats,
 geometry:(step,[input])=>{validStep(step);dilationLayout(input!.format,input!.width,input!.height);return {width:input!.width,height:input!.height};},
 frame:(frame,step,options)=>dilateVideoFrame(frame,step,options)});
