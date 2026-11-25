// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_neighbor.c (erosion). See ../../NOTICE-EROSION.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export type ErosionStep={readonly name:'erosion';readonly coordinates:number;readonly thresholds:readonly [number,number,number,number]};
export class VideoErosionError extends Error {}
/** The pinned vf_neighbor.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * A negotiated format outside the executable table is refused at plan time. */
export const erosionPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit planar members with frame storage here. */
const executable:readonly string[]=Object.freeze(erosionPixelFormats.filter(executableFormat));
const keys=['coordinates','threshold0','threshold1','threshold2','threshold3'] as const;
/** AV_OPT_TYPE_INT options in native declaration order, which is also the shorthand order. */
export function parseErosionOptions(options:string|null):ErosionStep{
 let coordinates=255;const thresholds:[number,number,number,number]=[65535,65535,65535,65535];
 for(const option of filterOptions(options,keys)){
  if(option.key==='enable')throw new VideoFilterParseError('Erosion timeline expressions are not implemented');
  const index=keys.indexOf(option.key as typeof keys[number]);if(index<0)throw new VideoFilterParseError('Unsupported erosion option');
  let value:number;try{value=index?filterIntegerOption(option.value,{min:0,max:65535,defaultValue:65535}):filterIntegerOption(option.value,{min:0,max:255,defaultValue:255});}catch{throw new VideoFilterParseError(`Invalid erosion ${option.key}`);}
  if(index)thresholds[index-1]=value;else coordinates=value;
 }
 return Object.freeze({name:'erosion',coordinates,thresholds:Object.freeze(thresholds)});
}
/** Native coordinateslb/coordinatesrb read column 1 of every plane, past the row when a plane is one pixel wide. */
function erosionLayout(pixelFormat:string,width:number,height:number){
 const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoErosionError('Erosion pixel format is not supported');
 if(layout.planes.some(plane=>plane.width<2))throw new VideoErosionError('Erosion of one pixel wide planes is not implemented');return layout;
}
function checkStep(step:ErosionStep){const {coordinates,thresholds}=step;if(!Number.isInteger(coordinates)||coordinates<0||coordinates>255||!Array.isArray(thresholds)||thresholds.length!==4||thresholds.some(value=>!Number.isInteger(value)||value<0||value>65535))throw new VideoErosionError('Invalid erosion settings');}
/** filter_slice: 3x3 minimum over the coordinates mask, floored at p - threshold; threshold 0 copies the plane. */
export function erodeVideoFrame(frame:VideoFrameData,step:ErosionStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 const layout=erosionLayout(frame.pixelFormat,frame.width,frame.height),mask=step.coordinates;
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoErosionError('Erosion frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoErosionError('Invalid erosion plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoErosionError('Invalid erosion plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoErosionError('Erosion input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoErosionError('Invalid erosion timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,threshold=step.thresholds[index]!,width=plane.width,height=plane.height;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const row=y*stride,target=plane.offset+y*width;
   if(!threshold){data.set(src.subarray(row,row+width),target);continue;}
   // nh/ph clamp the neighbour rows to the current row at the top and bottom edges.
   const up=y>0?row-stride:row,down=y<height-1?row+stride:row;
   for(let x=0;x<width;x++){
    if((x&16383)===0&&x)signal?.throwIfAborted();
    // coordinateslb/coordinatesrb mirror the missing left and right columns onto columns 1 and width-2.
    const l=x>0?x-1:1,r=x<width-1?x+1:width-2,p=src[row+x]!;let min=p;
    if(mask&1&&src[up+l]!<min)min=src[up+l]!;if(mask&2&&src[up+x]!<min)min=src[up+x]!;if(mask&4&&src[up+r]!<min)min=src[up+r]!;
    if(mask&8&&src[row+l]!<min)min=src[row+l]!;if(mask&16&&src[row+r]!<min)min=src[row+r]!;
    if(mask&32&&src[down+l]!<min)min=src[down+l]!;if(mask&64&&src[down+x]!<min)min=src[down+x]!;if(mask&128&&src[down+r]!<min)min=src[down+r]!;
    const limit=p-threshold;data[target+x]=min<limit?limit:min;
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** Stateless per-frame operator; enable= and runtime commands are refused. */
export const erosionOperator=defineVideoOperator<ErosionStep>({name:'erosion',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['erosion','erosion=coordinates=85:threshold0=10','erosion=0:1,hflip','format=yuv444p,erosion=170:0:20:30'],
 parse:token=>singlePad(parseErosionOptions(token.options)),
 formats:()=>erosionPixelFormats,
 geometry:(_step,[input])=>{if(!input)throw new VideoErosionError('Erosion needs one input');erosionLayout(input.format,input.width,input.height);return {width:input.width,height:input.height};},
 frame:(frame,step,options)=>erodeVideoFrame(frame,step,options)});
