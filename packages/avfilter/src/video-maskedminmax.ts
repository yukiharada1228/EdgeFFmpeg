// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_maskedminmax.c. See ../NOTICE-MASKEDMINMAX.
// Copyright (c) 2019 Paul B Mahol.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
import {filterIntegerOption} from './activation/integer-option.js';
import type {FilterToken,FilterPads} from './filter-topology.js';
import {VideoFilterParseError} from './video-ops/descriptor.js';
import type {VideoFrameOptions,VideoShape,VideoSize} from './video-ops/descriptor.js';
import {executableFormat} from './video-ops/formats.js';
export class VideoMaskedMinMaxError extends Error {}
export type MaskedMinMaxName='maskedmin'|'maskedmax';
/** Join step: native exposes no framesync options, so shortest is always false (EXT_INFINITY after every input). */
export interface MaskedMinMaxStep<N extends MaskedMinMaxName=MaskedMinMaxName> {readonly name:N;readonly planes:number;readonly shortest:false}
/** The pinned vf_maskedminmax.c pix_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const maskedMinMaxPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le grayf32le gbrpf32le gbrapf32le'.split(' '));
/** The eight-bit members with frame storage here: yuv444p, yuv422p, yuva420p, yuv420p, gbrp and gray. */
const executable:ReadonlySet<string>=new Set(maskedMinMaxPixelFormats.filter(executableFormat));
/** maskedminmax_options: one AV_OPT_TYPE_INT plane mask, 0..15, default 15; it is also the only shorthand. */
export function parseMaskedMinMax<N extends MaskedMinMaxName>(name:N,token:FilterToken):FilterPads<MaskedMinMaxStep<N>>{
 let planes=15;
 for(const option of filterOptions(token.options,['planes'])){
  if(option.key==='enable')throw new VideoFilterParseError(`${name} timeline expressions are not implemented`);
  if(option.key!=='planes')throw new VideoFilterParseError(`Unsupported ${name} option`);
  try{planes=filterIntegerOption(option.value,{min:0,max:15,defaultValue:15});}catch{throw new VideoFilterParseError(`Invalid ${name} planes`);}
 }
 return {inputs:3,outputs:1,configuration:Object.freeze({name,planes,shortest:false as const})};
}
/** config_output refuses source, filter1 and filter2 of different sizes with EINVAL; the negotiators give every pad one format. */
export function maskedMinMaxGeometry(name:MaskedMinMaxName,inputs:readonly VideoShape[]):VideoSize{
 if(inputs.length!==3)throw new VideoMaskedMinMaxError(`${name} requires three inputs`);
 const [source]=inputs as [VideoShape];
 if(inputs.some(input=>input.width!==source.width||input.height!==source.height))throw new VideoMaskedMinMaxError(`${name} input sizes differ`);
 if(inputs.some(input=>input.format!==source.format))throw new VideoMaskedMinMaxError(`${name} input formats differ`);
 return {width:source.width,height:source.height};
}
const sameTime=(a:VideoFrameData['pts'],b:VideoFrameData['pts'])=>a===null?b===null:b!==null&&a.value*a.timeBase.num*b.timeBase.den===b.value*b.timeBase.num*a.timeBase.den;
/** process_frame and maskedminmax_slice: for each selected plane, maskedmin8 keeps filter2 where |src-f2| < |src-f1| and maskedmax8 where
 * |src-f2| > |src-f1|, filter1 otherwise (ties keep filter1); unselected planes are copied from source. Output takes the source props. */
export function maskedMinMaxFrames(frames:readonly VideoFrameData[],step:MaskedMinMaxStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if((step.name!=='maskedmin'&&step.name!=='maskedmax')||!Number.isInteger(step.planes)||step.planes<0||step.planes>15)throw new VideoMaskedMinMaxError('Invalid maskedminmax settings');
 const name=step.name;if(frames.length!==3)throw new VideoMaskedMinMaxError(`${name} requires three frames`);
 maskedMinMaxGeometry(name,frames.map(frame=>({format:frame.pixelFormat,width:frame.width,height:frame.height})));
 const [source]=frames as [VideoFrameData],layout=pixelLayout(source.pixelFormat,source.width,source.height);
 if(!executable.has(layout.pixelFormat))throw new VideoMaskedMinMaxError(`${name} pixel format is not supported`);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoMaskedMinMaxError(`${name} frame exceeds allocation limit`);
 for(const frame of frames){
  if(frame.pts!==null&&(typeof frame.pts.value!=='bigint'||typeof frame.pts.timeBase.num!=='bigint'||typeof frame.pts.timeBase.den!=='bigint'||frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoMaskedMinMaxError(`Invalid ${name} timestamp`);
  if(!sameTime(frame.pts,source.pts))throw new VideoMaskedMinMaxError(`${name} frames must have synchronized timestamps`);
  if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoMaskedMinMaxError(`Invalid ${name} plane count`);
  let storage=0;for(const [p,plane]of layout.planes.entries()){const bytes=frame.planes[p],stride=frame.linesizes[p];if(!(bytes instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||bytes.length<stride!*(plane.height-1)+plane.rowBytes)throw new VideoMaskedMinMaxError(`Invalid ${name} input storage`);storage+=bytes.length;}
  if(storage>maxFrameBytes)throw new VideoMaskedMinMaxError(`${name} input storage exceeds frame budget`);
 }
 const [,first,second]=frames as [VideoFrameData,VideoFrameData,VideoFrameData],data=new Uint8Array(layout.bytes),min=name==='maskedmin';
 for(const [p,plane]of layout.planes.entries()){
  const s=source.planes[p]!,a=first.planes[p]!,b=second.planes[p]!,ss=source.linesizes[p]!,as=first.linesizes[p]!,bs=second.linesizes[p]!,selected=(step.planes>>p&1)===1;
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const out=plane.offset+y*plane.rowBytes,si=y*ss;
   if(!selected){data.set(s.subarray(si,si+plane.rowBytes),out);continue;}
   const ai=y*as,bi=y*bs;
   for(let x=0;x<plane.rowBytes;x++){const v=s[si+x]!,f1=a[ai+x]!,f2=b[bi+x]!,d1=Math.abs(v-f1),d2=Math.abs(v-f2);data[out+x]=(min?d2<d1:d2>d1)?f2:f1;}
  }
 }
 // vf_maskedminmax rescales the sync event without PASS_MINMAX, clamping MIN to MIN+1.
 return {width:source.width,height:source.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:source.pts===null?null:{value:source.pts.value===-(1n<<63n)?-(1n<<63n)+1n:source.pts.value,timeBase:{...source.pts.timeBase}},metadata:{...source.metadata}};
}
