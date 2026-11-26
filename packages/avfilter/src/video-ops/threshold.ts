// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_threshold.c and vf_threshold_init.h. See ../../NOTICE-THRESHOLD.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator} from './descriptor.js';
import type {VideoFrameOptions,VideoShape} from './descriptor.js';
import {executableFormat} from './formats.js';
/** Native sets after=EXT_STOP on all four inputs, so the step always ends with the shortest input (vf_stack shortest semantics). */
export type ThresholdStep={readonly name:'threshold';readonly planes:number;readonly shortest:true};
/** The pinned pix_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const thresholdPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv440p10le yuv444p10le yuv420p12le yuv422p12le yuv440p12le yuv444p12le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit members with frame storage here. */
const executable:readonly string[]=Object.freeze(thresholdPixelFormats.filter(executableFormat));
/** AV_OPT_TYPE_INT planes (0..15, default 15). Native has no shortest option; enable= and every other option are refused. */
export function parseThresholdOptions(options:string|null):ThresholdStep{
 let planes=15;
 for(const option of filterOptions(options,['planes'])){
  if(option.key==='planes'){try{planes=filterIntegerOption(option.value,{min:0,max:15,defaultValue:15});}catch(error){throw new VideoFilterParseError(`Invalid threshold planes: ${(error as Error).message}`);}}
  else if(option.key==='enable')throw new VideoFilterParseError('Threshold timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported threshold option');
 }
 return Object.freeze({name:'threshold',planes,shortest:true});
}
const pads=(token:FilterToken):FilterPads<ThresholdStep>=>({inputs:4,outputs:1,configuration:parseThresholdOptions(token.options)});
/** config_output: the threshold, min and max links must match the first link's size; ff_set_common_formats shares one format. */
export function thresholdGeometry(inputs:readonly Pick<VideoShape,'format'|'width'|'height'>[]){
 if(inputs.length!==4)throw new Error('Threshold requires four inputs');
 const [first]=inputs as [VideoShape];
 if(inputs.some(input=>input.width!==first.width||input.height!==first.height))throw new Error('Threshold input sizes differ');
 const formats=inputs.map(input=>pixelLayout(input.format,input.width,input.height).pixelFormat);
 if(formats.some(format=>format!==formats[0]))throw new Error('Threshold input pixel formats differ');
 return {width:first.width,height:first.height};
}
/** process_frame with threshold8: dst = in <= threshold ? min : max on masked planes; unmasked planes are copied from the first
 * input. Props come from the first input. Owned tight planes. */
export function thresholdVideoFrames(frames:readonly VideoFrameData[],step:ThresholdStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {planes}=step;if(!Number.isInteger(planes)||planes<0||planes>15||step.shortest!==true)throw new Error('Invalid threshold settings');
 if(frames.length!==4)throw new Error('Threshold requires four inputs');
 const size=thresholdGeometry(frames.map(frame=>({format:frame.pixelFormat,width:frame.width,height:frame.height}))),first=frames[0]!;
 const layout=pixelLayout(first.pixelFormat,size.width,size.height);if(!executable.includes(layout.pixelFormat))throw new Error('Threshold pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new Error('Threshold frame exceeds allocation limit');
 for(const frame of frames){
  if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Invalid threshold plane count');
  let resident=0n;
  for(const [index,plane]of layout.planes.entries()){
   const input=frame.planes[index],stride=frame.linesizes[index];
   if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid threshold plane stride or storage');
   resident+=BigInt(input.length);
  }
  if(resident>BigInt(maxFrameBytes))throw new Error('Threshold input plane storage exceeds allocation limit');
  if(frame.pts&&(typeof frame.pts.value!=='bigint'||frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid threshold timestamp');
  if(frame.pts===null?first.pts!==null:first.pts===null||frame.pts.value*frame.pts.timeBase.num*first.pts.timeBase.den!==first.pts.value*first.pts.timeBase.num*frame.pts.timeBase.den)throw new Error('Threshold frames must have synchronized timestamps');
 }
 const [source,limit,low,high]=frames as [VideoFrameData,VideoFrameData,VideoFrameData,VideoFrameData],data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const s=source.planes[index]!,t=limit.planes[index]!,l=low.planes[index]!,h=high.planes[index]!,ss=source.linesizes[index]!,ts=limit.linesizes[index]!,ls=low.linesizes[index]!,hs=high.linesizes[index]!,active=(planes>>index&1)===1;
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const target=plane.offset+y*plane.rowBytes,a=y*ss,b=y*ts,c=y*ls,d=y*hs;
   if(!active){data.set(s.subarray(a,a+plane.rowBytes),target);continue;}
   for(let x=0;x<plane.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();data[target+x]=s[a+x]!<=t[b+x]!?l[c+x]!:h[d+x]!;}
  }
 }
 // The synchronized event is rescaled without PASS_MINMAX, clamping MIN to MIN+1, as for vf_stack.
 return {width:size.width,height:size.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:first.pts===null?null:{value:first.pts.value===-(1n<<63n)?-(1n<<63n)+1n:first.pts.value,timeBase:{...first.pts.timeBase}},metadata:{...first.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const thresholdOperator=defineVideoOperator<ThresholdStep>({name:'threshold',role:'join',paths:['graph','stream','actor','timed'],
 examples:['split=4[a][b][c][d];[a][b][c][d]threshold','split=4[a][b][c][d];[a]hflip[e];[b]vflip[f];[e][f][c][d]threshold=planes=1','split=4[a][b][c][d];[d]hflip[e];[b][a][c][e]threshold=0'],
 parse:pads,formats:()=>thresholdPixelFormats,geometry:(_step,inputs)=>thresholdGeometry(inputs),
 combine:(frames,step,options)=>thresholdVideoFrames(frames,step,options),stateful:()=>true});
