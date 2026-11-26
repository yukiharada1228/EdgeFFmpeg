// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_maskedmerge.c (maskedmerge_options, pix_fmts, MASKEDMERGE(8), config_input,
// config_output, filter_slice, process_frame). See ../../NOTICE-MASKEDMERGE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator} from './descriptor.js';
import type {VideoFrameOptions,VideoShape,VideoSize} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoMaskedMergeError extends Error {}
/** shortest is the join role field; maskedmerge declares no framesync options, so it is always false. */
export type MaskedMergeStep={readonly name:'maskedmerge';readonly planes:number;readonly shortest:false};
/** The pinned pix_fmts in declared order (native-endian names), shared by base, overlay and mask as ff_set_common_formats does.
 * A negotiated format outside the executable table is refused at plan time. */
export const maskedmergePixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le grayf32le gbrpf32le gbrapf32le'.split(' '));
/** The eight-bit members with frame storage here. */
const executable:readonly string[]=Object.freeze(maskedmergePixelFormats.filter(executableFormat));
const range={min:0,max:15,defaultValue:15} as const;
/** AV_OPT_TYPE_INT planes in [0, 0xF]; enable= (TIMELINE_INTERNAL) and runtime commands are refused. */
export function parseMaskedMergeOptions(options:string|null):MaskedMergeStep{
 let planes=15;
 for(const option of filterOptions(options,['planes'])){
  if(option.key==='planes'){try{planes=filterIntegerOption(option.value,range);}catch(error){throw new VideoFilterParseError(`Invalid maskedmerge planes: ${(error as Error).message}`);}}
  else if(option.key==='enable')throw new VideoFilterParseError('Maskedmerge timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported maskedmerge option');
 }
 return Object.freeze({name:'maskedmerge',planes,shortest:false});
}
const pads=(token:FilterToken):FilterPads<MaskedMergeStep>=>({inputs:3,outputs:1,configuration:parseMaskedMergeOptions(token.options)});
/** config_output: base, overlay and mask must share one size; the output keeps it. */
export function maskedMergeGeometry(inputs:readonly VideoShape[]):VideoSize{
 if(inputs.length!==3)throw new VideoMaskedMergeError('Maskedmerge requires base, overlay and mask inputs');
 const [base,overlay,mask]=inputs as readonly [VideoShape,VideoShape,VideoShape];
 if(overlay.format!==base.format||mask.format!==base.format)throw new VideoMaskedMergeError('Maskedmerge input pixel formats differ');
 if(base.width!==overlay.width||base.height!==overlay.height||base.width!==mask.width||base.height!==mask.height)throw new VideoMaskedMergeError(`Maskedmerge input sizes differ: base ${base.width}x${base.height}, overlay ${overlay.width}x${overlay.height}, mask ${mask.width}x${mask.height}`);
 return {width:base.width,height:base.height};
}
/** process_frame with maskedmerge8: (b*(255-m) + m*o + 127) / 255 on selected planes, base plane copy on the rest.
 * Output props and metadata come from base; the timestamp is the synchronized event's. Owned tight planes. */
export function maskedMergeVideoFrames(frames:readonly VideoFrameData[],step:MaskedMergeStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();const {planes}=step;
 if(!Number.isInteger(planes)||planes<0||planes>15)throw new VideoMaskedMergeError('Invalid maskedmerge settings');
 if(frames.length!==3)throw new VideoMaskedMergeError('Maskedmerge requires base, overlay and mask inputs');
 maskedMergeGeometry(frames.map(frame=>({format:frame.pixelFormat,width:frame.width,height:frame.height})));
 const base=frames[0]!,layout=pixelLayout(base.pixelFormat,base.width,base.height);if(!executable.includes(layout.pixelFormat))throw new VideoMaskedMergeError('Maskedmerge pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoMaskedMergeError('Maskedmerge frame exceeds allocation limit');
 for(const frame of frames){
  if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoMaskedMergeError('Invalid maskedmerge plane count');
  let resident=0n;
  for(const [index,plane]of layout.planes.entries()){
   const input=frame.planes[index],stride=frame.linesizes[index];
   if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoMaskedMergeError('Invalid maskedmerge plane stride or storage');
   resident+=BigInt(input.length);
  }
  if(resident>BigInt(maxFrameBytes))throw new VideoMaskedMergeError('Maskedmerge input plane storage exceeds allocation limit');
  const pts=frame.pts;if(pts&&(typeof pts.value!=='bigint'||pts.timeBase.num<=0n||pts.timeBase.den<=0n))throw new VideoMaskedMergeError('Invalid maskedmerge timestamp time base');
  if(pts===null?base.pts!==null:base.pts===null||pts.value*pts.timeBase.num*base.pts.timeBase.den!==base.pts.value*base.pts.timeBase.num*pts.timeBase.den)throw new VideoMaskedMergeError('Maskedmerge frames must have synchronized timestamps');
 }
 const overlay=frames[1]!,mask=frames[2]!,data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const b=base.planes[index]!,o=overlay.planes[index]!,m=mask.planes[index]!,bs=base.linesizes[index]!,os=overlay.linesizes[index]!,ms=mask.linesizes[index]!,active=(planes>>index&1)===1;
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const target=plane.offset+y*plane.rowBytes,br=y*bs;
   if(!active){data.set(b.subarray(br,br+plane.rowBytes),target);continue;}
   const or=y*os,mr=y*ms;
   for(let x=0;x<plane.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();const value=m[mr+x]!;data[target+x]=((b[br+x]!*(255-value)+value*o[or+x]!+127)/255)|0;}
  }
 }
 // av_rescale_q without PASS_MINMAX clamps INT64_MIN to INT64_MIN+1, as vf_stack does.
 return {width:base.width,height:base.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:base.pts===null?null:{value:base.pts.value===-(1n<<63n)?-(1n<<63n)+1n:base.pts.value,timeBase:{...base.pts.timeBase}},metadata:{...base.metadata}};
}
/** Three synchronized inputs (vf_stack framesync semantics: sync=1, EXT_STOP before, EXT_INFINITY after on every pad). */
export const maskedmergeOperator=defineVideoOperator<MaskedMergeStep>({name:'maskedmerge',role:'join',paths:['graph','stream','actor','timed'],
 examples:['split=3[a][b][c];[a][b][c]maskedmerge','split=3[a][b][c];[a]hflip[x];[c]vflip[z];[x][b][z]maskedmerge=planes=1','format=yuv420p,split=3[a][b][c];[a][b][c]maskedmerge=planes=5','format=gbrp,split=3[a][b][c];[c]transpose[t];[t]transpose=2[m];[a][b][m]maskedmerge=planes=0'],
 parse:pads,formats:()=>maskedmergePixelFormats,geometry:(_step,inputs)=>maskedMergeGeometry(inputs),
 combine:(frames,step,options)=>maskedMergeVideoFrames(frames,step,options),stateful:()=>true});
