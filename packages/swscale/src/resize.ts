import {scaleSampleAspectRatio,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import {convertedColorMetadata,sourceRangeMetadata} from './inverse-coefficients.js';
// SPDX-License-Identifier: LGPL-2.1-or-later
// Row arithmetic adapted from FFmpeg libswscale/swscale.c and output.c at
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (C) 2001-2011 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2001-2012 Michael Niedermayer <michaelni@gmx.at>
// See ../NOTICE and ../LICENSES/LGPL-2.1-or-later.txt.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {convertVideoFrame,pixelConversionStateBytes} from './convert.js';
import type {PixelArithmetic} from './inverse.js';
import {inverseResizePlan,renderInverseResize} from './inverse-resize.js';
import {componentResizeSamples,renderComponentResize} from './component-resize.js';
import {isRgbResizeFormat,rgbResizeRowBytes,renderRgbResize} from './rgb-resize.js';
import {bicubicAxis,bicubicAxisBound} from './chroma-filter.js';
import type {ChromaAxis} from './chroma-filter.js';
export class PixelResizeError extends Error {}
export interface PixelResizeOptions {readonly maxFrameBytes:number;readonly maxStateBytes?:number;readonly signal?:AbortSignal;readonly outputPixelFormat?:string;readonly arithmetic?:PixelArithmetic}
export function canResizePixelFormat(format:string,destination:string=videoStoragePixelFormat(format)):boolean{
 const supported=(name:string)=>isRgbResizeFormat(videoStoragePixelFormat(name))||['gray','gray8','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'].includes(videoStoragePixelFormat(name));
 return videoStoragePixelFormat(destination)===destination&&supported(format)&&supported(destination);
}
const axisKey=(one:number,src:number,dst:number)=>`${one}/${src}/${dst}`;
function resizePlan(pixelFormat:string,sw:number,sh:number,dw:number,dh:number,outputPixelFormat:string=videoStoragePixelFormat(pixelFormat),arithmetic:PixelArithmetic='aarch64'){
 const input=pixelLayout(videoStoragePixelFormat(pixelFormat),sw,sh),output=pixelLayout(outputPixelFormat,dw,dh);
 if(!canResizePixelFormat(input.pixelFormat,output.pixelFormat))throw new PixelResizeError('Unsupported resize pixel format');
 const axes=new Map<string,{src:number;dst:number;one:number;bytes:number}>();let rowWidth=0;
 const inverse=isRgbResizeFormat(output.pixelFormat)&&!isRgbResizeFormat(input.pixelFormat)&&input.pixelFormat!=='gray'?inverseResizePlan(input,output):null,rgb=isRgbResizeFormat(input.pixelFormat)&&isRgbResizeFormat(output.pixelFormat),samples=rgb||inverse?[]:componentResizeSamples(input,output);
 const addAxis=(src:number,dst:number,one:number)=>{const key=axisKey(one,src,dst);if(!axes.has(key))axes.set(key,{src,dst,one,bytes:bicubicAxisBound(src,dst,one,arithmetic==='scalar'?1:undefined).bytes});};
 if(inverse){for(const [src,dst,one]of inverse.axes)addAxis(src,dst,one);}
 else if(rgb){
  const chromaWidth=sw%2===0&&dw<=sw/2?sw/2:sw;
  addAxis(sw,dw,16384);addAxis(chromaWidth,dw,16384);addAxis(sh,dh,4096);
 }else for(const sample of samples){
  if(sample.constant!==null)continue;const target=output.planes[sample.target.plane]!;
  addAxis(sample.width,target.width,16384);addAxis(sample.height,target.height,4096);
  if(sample.height!==target.height)rowWidth=Math.max(rowWidth,target.width);
 }
 const bytes=[...axes.values()].reduce((sum,axis)=>sum+BigInt(axis.bytes),BigInt(inverse?inverse.rowBytes:rgb&&(sw!==dw||sh!==dh)?rgbResizeRowBytes(input.pixelFormat,dw,output.pixelFormat):4*rowWidth));
 if(bytes>BigInt(Number.MAX_SAFE_INTEGER))throw new PixelResizeError('Resize state exceeds safe size');
 return {input,output,axes,rowWidth,inverse,rgb,samples,bytes:Number(bytes)};
}
/** Shared axes and bounded accumulation rows, before pixel access or typed allocations. */
export function pixelResizeStateBytes(pixelFormat:string,sw:number,sh:number,dw:number,dh:number,outputPixelFormat:string=videoStoragePixelFormat(pixelFormat),arithmetic:PixelArithmetic='aarch64'):number{
 if(!['aarch64','scalar','x86_64'].includes(arithmetic))throw new PixelResizeError('Invalid pixel arithmetic profile');
 if(sw===dw&&sh===dh&&pixelLayout(videoStoragePixelFormat(pixelFormat),sw,sh).pixelFormat!==pixelLayout(outputPixelFormat,dw,dh).pixelFormat)return pixelConversionStateBytes(pixelFormat,outputPixelFormat,sw,sh,arithmetic);
 return resizePlan(pixelFormat,sw,sh,dw,dh,outputPixelFormat,arithmetic).bytes;
}
/** Fixed-default bicubic 8-bit resize with owned tight output and shared row workspace. */
export function resizeVideoFrame(frame:VideoFrameData,width:number,height:number,options:PixelResizeOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(options.arithmetic!==undefined&&!['aarch64','scalar','x86_64'].includes(options.arithmetic))throw new PixelResizeError('Invalid pixel arithmetic profile');
 const outputFormat=options.outputPixelFormat??videoStoragePixelFormat(frame.pixelFormat),sourceMetadata=sourceRangeMetadata(frame.metadata,frame.pixelFormat),numericFrame=sourceMetadata===frame.metadata?frame:{...frame,metadata:sourceMetadata};
 if(frame.width===width&&frame.height===height&&pixelLayout(videoStoragePixelFormat(frame.pixelFormat),width,height).pixelFormat!==pixelLayout(outputFormat,width,height).pixelFormat)return convertVideoFrame(frame,outputFormat,options);
 const plan=resizePlan(frame.pixelFormat,frame.width,frame.height,width,height,outputFormat,options.arithmetic),{input,output}=plan;
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||input.bytes>maxFrameBytes||output.bytes>maxFrameBytes)throw new PixelResizeError('Resize frame exceeds allocation limit');
 if(frame.planes.length!==input.planes.length||frame.linesizes.length!==input.planes.length)throw new PixelResizeError('Invalid resize plane count');
 let resident=0n;
 for(const [index,p]of input.planes.entries()){
  const plane=frame.planes[index],stride=frame.linesizes[index];
  if(!(plane instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<p.rowBytes||stride!>2147483647||plane.length<stride!*(p.height-1)+p.rowBytes)throw new PixelResizeError('Invalid resize plane stride or storage');
  resident+=BigInt(plane.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new PixelResizeError('Resize input plane storage exceeds frame allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new PixelResizeError('Invalid resize timestamp time base');
 const stateBytes=plan.bytes,maxStateBytes=options.maxStateBytes??maxFrameBytes;
 if(!Number.isSafeInteger(maxStateBytes)||maxStateBytes<0||stateBytes>maxStateBytes)throw new PixelResizeError('Resize state exceeds allocation limit');
 const axes=new Map<string,ChromaAxis|null>();
 for(const [key,axis]of plan.axes)axes.set(key,bicubicAxis(axis.src,axis.dst,axis.one,maxStateBytes,signal,options.arithmetic==='scalar'?1:undefined));
 const getAxis=(one:number,src:number,dst:number)=>{const axis=axes.get(axisKey(one,src,dst));if(axis===undefined)throw new PixelResizeError('Missing resize axis');return axis;};
 const data=plan.inverse?renderInverseResize(numericFrame,input,output,plan.inverse,getAxis,options.arithmetic??'aarch64',signal):plan.rgb?renderRgbResize(numericFrame,output,getAxis,signal):renderComponentResize(numericFrame,output,plan.samples,plan.rowWidth,getAxis,signal);
 const metadata=convertedColorMetadata(sourceMetadata,isRgbResizeFormat(input.pixelFormat),isRgbResizeFormat(output.pixelFormat),output.pixelFormat==='gray');if(metadata.sampleAspectRatio!==undefined&&(width!==frame.width||height!==frame.height))metadata.sampleAspectRatio=scaleSampleAspectRatio(metadata.sampleAspectRatio as Rational,frame.width,frame.height,width,height);
 return {width,height,pixelFormat:output.pixelFormat,planes:output.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:output.planes.map(p=>p.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata};
}
