// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_avgblur.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../../NOTICE-AVGBLUR.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoAvgblurError extends Error {}
/** sizeY 0 keeps native's "same as sizeX" until config_input resolves it. */
export type AvgblurStep={readonly name:'avgblur';readonly sizeX:number;readonly planes:number;readonly sizeY:number};
/** The pinned vf_avgblur.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * A negotiated format outside the executable table is refused at plan time. */
export const avgblurPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit planar members with frame storage here. */
const executable:readonly string[]=Object.freeze(avgblurPixelFormats.filter(executableFormat));
const keys=['sizeX','planes','sizeY'] as const,ranges=[{min:1,max:1024,defaultValue:1},{min:0,max:15,defaultValue:15},{min:0,max:1024,defaultValue:0}] as const;
/** Declared AVOptions in native order, which is also the shorthand order; enable= and every other option are refused. */
export function parseAvgblurOptions(options:string|null):AvgblurStep{
 const values=[1,15,0];
 for(const option of filterOptions(options,keys)){
  if(option.key==='enable')throw new VideoFilterParseError('Avgblur timeline expressions are not implemented');
  const index=(keys as readonly string[]).indexOf(option.key);if(index<0)throw new VideoFilterParseError('Unsupported avgblur option');
  try{values[index]=filterIntegerOption(option.value,ranges[index]!);}catch{throw new VideoFilterParseError(`Invalid avgblur ${option.key}`);}
 }
 return Object.freeze({name:'avgblur',sizeX:values[0]!,planes:values[1]!,sizeY:values[2]!});
}
function validStep(step:AvgblurStep):void{
 if(!Number.isInteger(step.sizeX)||step.sizeX<1||step.sizeX>1024||!Number.isInteger(step.sizeY)||step.sizeY<0||step.sizeY>1024||!Number.isInteger(step.planes)||step.planes<0||step.planes>15)throw new VideoAvgblurError('Invalid avgblur settings');
}
function avgblurLayout(pixelFormat:string,width:number,height:number){
 const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoAvgblurError('Avgblur pixel format is not supported');return layout;
}
/** config_input: sizeY 0 takes sizeX, then both radii are clipped to half of plane 1 (the chroma plane, or the frame for gray and gbrp) for every plane. */
export function avgblurRadii(step:AvgblurStep,pixelFormat:string,width:number,height:number):{readonly radius:number;readonly radiusV:number}{
 const plane=avgblurLayout(pixelFormat,width,height).planes[1]??{width,height};
 return {radius:Math.min(plane.width>>1,step.sizeX),radiusV:Math.min(plane.height>>1,step.sizeY||step.sizeX)};
}
/** averageiir2d with filter_lut8/filter_slow8: per-column running sums over 2*radiusV+1 clamped rows, then a running row sum over
 * 2*radius+1 clamped columns, divided by the area. LUT_DIV (lut[i]=floor(i/area)) and SLOW_DIV are the same truncating division. */
export function avgblurVideoFrame(frame:VideoFrameData,step:AvgblurStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();validStep(step);
 const layout=avgblurLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoAvgblurError('Avgblur frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoAvgblurError('Invalid avgblur plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoAvgblurError('Invalid avgblur plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoAvgblurError('Avgblur input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoAvgblurError('Invalid avgblur timestamp time base');
 const {radius:sw,radiusV:sh}=avgblurRadii(step,layout.pixelFormat,frame.width,frame.height),area=(2*sh+1)*(2*sw+1);
 const data=new Uint8Array(layout.bytes),columns=new Int32Array(frame.width+2*sw);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,width=plane.width,height=plane.height;
  if(!(step.planes&(1<<index))){for(let y=0;y<height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+width),plane.offset+y*width);}continue;}
  // columns[x+sw] is native col_sum[x] for x in [-sw, width+sw).
  for(let x=-sw;x<width+sw;x++){const c=x<0?0:x<width?x:width-1;let sum=input[c]!*sh;for(let y=0;y<=sh;y++)sum+=input[c+y*stride]!;columns[x+sw]=sum;}
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const row=y*stride,target=plane.offset+y*width;
   if(y){const syp=row+Math.min(sh,height-y-1)*stride,syn=row-Math.min(y,sh+1)*stride;for(let x=-sw;x<width+sw;x++){const c=x<0?0:x<width?x:width-1;columns[x+sw]=columns[x+sw]!+input[syp+c]!-input[syn+c]!;}}
   let sum=0;for(let x=0;x<=2*sw;x++)sum+=columns[x]!;data[target]=Math.trunc(sum/area);
   for(let x=1;x<width;x++){sum+=columns[x+2*sw]!-columns[x-1]!;data[target+x]=Math.trunc(sum/area);}
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
export const avgblurOperator=defineVideoOperator<AvgblurStep>({name:'avgblur',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['avgblur','avgblur=sizeX=2:planes=1:sizeY=3,hflip','avgblur=64:15:0'],
 parse:token=>singlePad(parseAvgblurOptions(token.options)),
 formats:()=>avgblurPixelFormats,
 geometry:(step,[input])=>{validStep(step);avgblurLayout(input!.format,input!.width,input!.height);return {width:input!.width,height:input!.height};},
 frame:(frame,step,options)=>avgblurVideoFrame(frame,step,options)});
