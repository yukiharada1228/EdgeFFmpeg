// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_maskedthreshold.c. See ../../NOTICE-MASKEDTHRESHOLD.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator} from './descriptor.js';
import type {VideoFrameOptions,VideoShape} from './descriptor.js';
import {executableFormat} from './formats.js';
/** shortest is the join role contract: vf_maskedthreshold exposes no framesync options, so it is always false. */
export type MaskedthresholdStep={readonly name:'maskedthreshold';readonly threshold:number;readonly planes:number;readonly mode:'abs'|'diff';readonly shortest:false};
export class VideoMaskedthresholdError extends Error {}
/** The pinned pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * A negotiated format outside the executable table is refused at plan time by the shared negotiators. */
export const maskedthresholdPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit members with frame storage here: threshold8_abs and threshold8_diff. */
const executable:readonly string[]=Object.freeze(maskedthresholdPixelFormats.filter(executableFormat));
const ranges={threshold:{min:0,max:65535,defaultValue:1},planes:{min:0,max:15,defaultValue:15},mode:{min:0,max:1,defaultValue:0,constants:{abs:0,diff:1}}} as const;
/** AV_OPT_TYPE_INT options in native declaration order, which is also the shorthand order. Generic filter options
 * (enable, threads) and framesync options, which this filter does not declare, are refused. */
export function parseMaskedthresholdOptions(options:string|null):MaskedthresholdStep{
 const values={threshold:1,planes:15,mode:0};
 for(const option of filterOptions(options,['threshold','planes','mode'])){
  if(option.key==='threshold'||option.key==='planes'||option.key==='mode'){
   try{values[option.key]=filterIntegerOption(option.value,ranges[option.key]);}catch(error){throw new VideoFilterParseError(`Invalid maskedthreshold ${option.key}: ${(error as Error).message}`);}
  }else if(option.key==='enable')throw new VideoFilterParseError('Maskedthreshold timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported maskedthreshold option');
 }
 return Object.freeze({name:'maskedthreshold',threshold:values.threshold,planes:values.planes,mode:values.mode?'diff':'abs',shortest:false});
}
const pads=(token:FilterToken):FilterPads<MaskedthresholdStep>=>({inputs:2,outputs:1,configuration:parseMaskedthresholdOptions(token.options)});
/** config_output: the reference must match the source size; both pads share one negotiated format. */
export function maskedthresholdGeometry(inputs:readonly VideoShape[]):{width:number;height:number}{
 if(inputs.length!==2)throw new VideoMaskedthresholdError('Maskedthreshold needs a source and a reference input');
 const [source,reference]=inputs as [VideoShape,VideoShape];
 if(source.format!==reference.format)throw new VideoMaskedthresholdError('Maskedthreshold input pixel formats differ');
 if(source.width!==reference.width||source.height!==reference.height)throw new VideoMaskedthresholdError(`First input link source parameters (size ${source.width}x${source.height}) do not match the corresponding second input link reference parameters (${reference.width}x${reference.height})`);
 return {width:source.width,height:source.height};
}
function checkStep(step:MaskedthresholdStep){const {threshold,planes,mode}=step;if(!Number.isInteger(threshold)||threshold<0||threshold>65535||!Number.isInteger(planes)||planes<0||planes>15||mode!=='abs'&&mode!=='diff')throw new VideoMaskedthresholdError('Invalid maskedthreshold settings');}
/** process_frame and threshold_slice: selected planes pick per pixel, unselected planes copy the reference plane
 * (av_image_copy_plane from ref), and frame properties follow the source. Owned tight planes. */
export function maskedthresholdVideoFrames(frames:readonly VideoFrameData[],step:MaskedthresholdStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 if(frames.length!==2)throw new VideoMaskedthresholdError('Maskedthreshold needs a source and a reference frame');
 const [source,reference]=frames as [VideoFrameData,VideoFrameData];
 maskedthresholdGeometry(frames.map(frame=>({format:frame.pixelFormat,width:frame.width,height:frame.height})));
 const layout=pixelLayout(source.pixelFormat,source.width,source.height);if(!executable.includes(layout.pixelFormat))throw new VideoMaskedthresholdError('Maskedthreshold pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoMaskedthresholdError('Maskedthreshold frame exceeds allocation limit');
 for(const frame of frames){
  if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoMaskedthresholdError('Invalid maskedthreshold plane count');
  let resident=0n;
  for(const [index,plane]of layout.planes.entries()){
   const input=frame.planes[index],stride=frame.linesizes[index];
   if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoMaskedthresholdError('Invalid maskedthreshold plane stride or storage');
   resident+=BigInt(input.length);
  }
  if(resident>BigInt(maxFrameBytes))throw new VideoMaskedthresholdError('Maskedthreshold input plane storage exceeds allocation limit');
  if(frame.pts&&(typeof frame.pts.value!=='bigint'||frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoMaskedthresholdError('Invalid maskedthreshold timestamp time base');
 }
 if(source.pts===null?reference.pts!==null:reference.pts===null||source.pts.value*source.pts.timeBase.num*reference.pts.timeBase.den!==reference.pts.value*reference.pts.timeBase.num*source.pts.timeBase.den)throw new VideoMaskedthresholdError('Maskedthreshold frames must have synchronized timestamps');
 const {threshold,planes,mode}=step,data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const src=source.planes[index]!,ref=reference.planes[index]!,srcStride=source.linesizes[index]!,refStride=reference.linesizes[index]!,width=plane.rowBytes,active=(planes>>index&1)===1;
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const s=y*srcStride,r=y*refStride,target=plane.offset+y*width;
   if(!active){data.set(ref.subarray(r,r+width),target);continue;}
   if(mode==='abs')for(let x=0;x<width;x++){if((x&16383)===0&&x)signal?.throwIfAborted();const a=src[s+x]!,b=ref[r+x]!;data[target+x]=(a>b?a-b:b-a)<=threshold?a:b;}
   else for(let x=0;x<width;x++){if((x&16383)===0&&x)signal?.throwIfAborted();const a=src[s+x]!,b=ref[r+x]!;data[target+x]=b-a<=threshold?(b>threshold?b-threshold:0):a;}
  }
 }
 // process_frame rescales the sync event without PASS_MINMAX, clamping MIN to MIN+1.
 return {width:source.width,height:source.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:source.pts===null?null:{value:source.pts.value===-(1n<<63n)?-(1n<<63n)+1n:source.pts.value,timeBase:{...source.pts.timeBase}},metadata:{...source.metadata}};
}
/** Two-input join with vf_stack sync semantics (sync=1, before=EXT_STOP, after=EXT_INFINITY on both inputs).
 * enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const maskedthresholdOperator=defineVideoOperator<MaskedthresholdStep>({name:'maskedthreshold',role:'join',paths:['graph','stream','actor','timed'],
 examples:['split[a][b];[a][b]maskedthreshold','split[a][b];[a]hflip[c];[c][b]maskedthreshold=threshold=40:mode=diff','split[a][b];[a]vflip[c];[b][c]maskedthreshold=200:1:abs','format=yuv420p,split[a][b];[a]hflip[c];[c][b]maskedthreshold=threshold=30:planes=5:mode=1'],
 parse:pads,
 formats:()=>maskedthresholdPixelFormats,
 geometry:(_step,inputs)=>maskedthresholdGeometry(inputs),
 combine:(frames,step,options)=>maskedthresholdVideoFrames(frames,step,options),
 stateful:()=>true});
