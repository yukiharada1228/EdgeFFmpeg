// SPDX-License-Identifier: LGPL-2.1-or-later
// Plane placement follows FFmpeg vf_stack.c at the pinned upstream commit.
// Copyright (c) 2015 Paul B. Mahol.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
export class VideoStackError extends Error {}
export type VideoStackDirection='horizontal'|'vertical';
export interface VideoStackOptions{readonly maxFrameBytes:number;readonly signal?:AbortSignal}
export interface StackShape {readonly format:string;readonly width:number;readonly height:number}
export function stackGeometry(inputs:readonly StackShape[],direction:VideoStackDirection){
 if(direction!=='horizontal'&&direction!=='vertical')throw new VideoStackError('Invalid stack direction');
 if(inputs.length<2||inputs.length>32)throw new VideoStackError('Stack requires two to thirty-two frames');
 const first=inputs[0]!,layouts=inputs.map(input=>pixelLayout(input.format,input.width,input.height));
 if(layouts.some(layout=>layout.pixelFormat!==layouts[0]!.pixelFormat))throw new VideoStackError('Stack pixel formats differ');
 if(inputs.some(input=>direction==='horizontal'?input.height!==first.height:input.width!==first.width))throw new VideoStackError('Stack perpendicular dimensions differ');
 const width=direction==='horizontal'?inputs.reduce((sum,input)=>sum+input.width,0):first.width,height=direction==='vertical'?inputs.reduce((sum,input)=>sum+input.height,0):first.height,output=pixelLayout(first.format,width,height);
 let offset=0;const regions=layouts.map((layout,index)=>{
  // Native av_image_fill_linesizes rounds subsampled chroma positions upward.
  const prefix=offset?pixelLayout(first.format,direction==='horizontal'?offset:first.width,direction==='vertical'?offset:first.height):null;
  const planes=layout.planes.map((plane,p)=>Object.freeze({x:direction==='horizontal'?(prefix?.planes[p]?.rowBytes??0):0,y:direction==='vertical'?(prefix?.planes[p]?.height??0):0,width:plane.rowBytes,height:plane.height}));
  offset+=direction==='horizontal'?inputs[index]!.width:inputs[index]!.height;return Object.freeze(planes);
 });
 for(let p=0;p<output.planes.length;p++)for(let i=0;i<regions.length;i++)for(let j=i+1;j<regions.length;j++){
  const a=regions[i]![p]!,b=regions[j]![p]!,plane=output.planes[p]!;
  if(Math.max(a.x,b.x)<Math.min(a.x+a.width,b.x+b.width,plane.rowBytes)&&Math.max(a.y,b.y)<Math.min(a.y+a.height,b.y+b.height,plane.height))throw new VideoStackError('Native parallel chroma placements overlap; stack geometry is unsupported');
 }
 return Object.freeze({format:output.pixelFormat,width,height,layout:output,regions:Object.freeze(regions)});
}
export function stackVideoFrames(frames:readonly VideoFrameData[],direction:VideoStackDirection,options:VideoStackOptions):VideoFrameData{
 options.signal?.throwIfAborted();const plan=stackGeometry(frames.map(frame=>({format:frame.pixelFormat,width:frame.width,height:frame.height})),direction),first=frames[0]!;
 if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<plan.layout.bytes)throw new VideoStackError('Stack output exceeds frame budget');
 for(const frame of frames){let storage=0n;if(frame.pts&&(typeof frame.pts.value!=='bigint'||typeof frame.pts.timeBase.num!=='bigint'||typeof frame.pts.timeBase.den!=='bigint'||frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoStackError('Invalid stack timestamp');const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);if(layout.bytes>options.maxFrameBytes||frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoStackError('Invalid stack input layout');
  if(frame.pts===null?first.pts!==null:first.pts===null||frame.pts.value*frame.pts.timeBase.num*first.pts.timeBase.den!==first.pts.value*first.pts.timeBase.num*frame.pts.timeBase.den)throw new VideoStackError('Stack frames must have synchronized timestamps');
  for(const [p,plane]of layout.planes.entries()){const bytes=frame.planes[p],stride=frame.linesizes[p];if(!(bytes instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||bytes.length<stride!*(plane.height-1)+plane.rowBytes)throw new VideoStackError('Invalid stack input storage');storage+=BigInt(bytes.length);}
  if(storage>BigInt(options.maxFrameBytes))throw new VideoStackError('Stack input storage exceeds frame budget');
 }
 const data=new Uint8Array(plan.layout.bytes);
 for(const [index,frame]of frames.entries())for(const [p,region]of plan.regions[index]!.entries()){
  const plane=plan.layout.planes[p]!,length=Math.max(0,Math.min(region.width,plane.rowBytes-region.x));if(!length)continue;
  for(let row=0;row<Math.min(region.height,plane.height-region.y);row++){options.signal?.throwIfAborted();const start=row*frame.linesizes[p]!;data.set(frame.planes[p]!.subarray(start,start+length),plane.offset+(region.y+row)*plane.rowBytes+region.x);}
 }
 // vf_stack rescales the sync event without PASS_MINMAX, clamping MIN to MIN+1.
 return {width:plan.width,height:plan.height,pixelFormat:plan.format,planes:plan.layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:plan.layout.planes.map(plane=>plane.rowBytes),pts:first.pts===null?null:{value:first.pts.value===-(1n<<63n)?-(1n<<63n)+1n:first.pts.value,timeBase:{...first.pts.timeBase}},metadata:{}};
}
