// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_swapuv.c. See ../../NOTICE-SWAPUV.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {bareStep} from './options.js';
import {negotiationOrder} from './formats.js';
export class VideoSwapuvError extends Error {}
export type SwapuvStep={readonly name:'swapuv'};
/** Native is_planar_yuv() over the negotiation table, in table order; gbrp fails the plane==component check. */
const formats=Object.freeze(negotiationOrder.filter(format=>['yuv420p','yuv422p','yuv444p','yuva420p'].includes(format)));
/** do_swap exchanges data[1] and data[2]; this materializes the swap into owned tight planes with positive strides. */
export function swapuvVideoFrame(frame:VideoFrameData,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(!(formats as readonly string[]).includes(frame.pixelFormat))throw new VideoSwapuvError('Swapuv pixel format is not supported');
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
