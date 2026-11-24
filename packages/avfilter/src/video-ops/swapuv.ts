// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_swapuv.c. See ../../NOTICE-SWAPUV.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {bareStep} from './options.js';
import {executableFormat} from './formats.js';
export class VideoSwapuvError extends Error {}
export type SwapuvStep={readonly name:'swapuv'};
/** Native is_planar_yuv() over every AVPixelFormat, in AVPixelFormat order: one component per plane at offset 0, equal chroma
 * depths, no flags but big-endian, planar and alpha. gbrp fails the plane==component check. A negotiated format outside the
 * executable table is refused at plan time. */
const formats=Object.freeze('yuv420p yuv422p yuv444p yuv410p yuv411p yuvj420p yuvj422p yuvj444p yuv440p yuvj440p yuva420p yuv420p16le yuv420p16be yuv422p16le yuv422p16be yuv444p16le yuv444p16be yuv420p9be yuv420p9le yuv420p10be yuv420p10le yuv422p10be yuv422p10le yuv444p9be yuv444p9le yuv444p10be yuv444p10le yuv422p9be yuv422p9le yuva422p yuva444p yuva420p9be yuva420p9le yuva422p9be yuva422p9le yuva444p9be yuva444p9le yuva420p10be yuva420p10le yuva422p10be yuva422p10le yuva444p10be yuva444p10le yuva420p16be yuva420p16le yuva422p16be yuva422p16le yuva444p16be yuva444p16le yuv420p12be yuv420p12le yuv420p14be yuv420p14le yuv422p12be yuv422p12le yuv422p14be yuv422p14le yuv444p12be yuv444p12le yuv444p14be yuv444p14le yuvj411p yuv440p10le yuv440p10be yuv440p12le yuv440p12be yuva422p12be yuva422p12le yuva444p12be yuva444p12le'.split(' '));
/** The members with frame storage here. */
const executable:readonly string[]=Object.freeze(formats.filter(executableFormat));
/** do_swap exchanges data[1] and data[2]; this materializes the swap into owned tight planes with positive strides. */
export function swapuvVideoFrame(frame:VideoFrameData,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(!executable.includes(frame.pixelFormat))throw new VideoSwapuvError('Swapuv pixel format is not supported');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoSwapuvError('Swapuv frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoSwapuvError('Invalid swapuv plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoSwapuvError('Invalid swapuv plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoSwapuvError('Swapuv input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoSwapuvError('Invalid swapuv timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const source=index===1?2:index===2?1:index,input=frame.planes[source]!,stride=frame.linesizes[source]!;
  for(let y=0;y<plane.height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** Option-free: enable= (native timeline generic) and runtime commands are refused. */
export const swapuvOperator=defineVideoOperator<SwapuvStep>({name:'swapuv',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuv420p,swapuv','format=yuv444p,swapuv,hflip','format=yuv422p,swapuv'],
 parse:token=>singlePad(bareStep('swapuv',token)),
 formats:()=>formats,
 frame:(frame,_step,options)=>swapuvVideoFrame(frame,options)});
