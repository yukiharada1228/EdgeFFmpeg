// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_lumakey.c. See ../../NOTICE-LUMAKEY.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoLumakeyError extends Error {}
export type LumakeyStep={readonly name:'lumakey';readonly threshold:number;readonly tolerance:number;readonly softness:number};
/** The pinned pixel_fmts in declared order (native-endian names). Only yuva420p has frame storage here: the shared negotiators
 * refuse any other pick by name at plan time. */
export const lumakeyPixelFormats:readonly string[]=Object.freeze('yuva444p yuva422p yuva420p yuva444p9le yuva422p9le yuva420p9le yuva444p10le yuva422p10le yuva420p10le yuva444p12le yuva422p12le yuva444p16le yuva422p16le yuva420p16le'.split(' '));
const executable:readonly string[]=Object.freeze(lumakeyPixelFormats.filter(executableFormat));
const names=['threshold','tolerance','softness'] as const,defaults={threshold:0,tolerance:0.01,softness:0} as const;
/** AV_OPT_TYPE_DOUBLE in [0, 1]. Only constant decimals are implemented: av_strtod reads them as Number does. */
function optionValue(name:typeof names[number],text:string):number{
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new VideoFilterParseError(`Only constant decimal lumakey ${name} values are implemented`);
 const value=Number(text);if(!(value>=0&&value<=1))throw new VideoFilterParseError(`Invalid lumakey ${name}: must be between 0 and 1`);
 return value===0?0:value;
}
/** Options applied in order (later occurrences win); enable= and every other option are refused. */
export function parseLumakeyOptions(options:string|null):LumakeyStep{
 const values:{threshold:number;tolerance:number;softness:number}={...defaults};
 for(const option of filterOptions(options,names)){
  if(option.key==='threshold'||option.key==='tolerance'||option.key==='softness')values[option.key]=optionValue(option.key,option.value);
  else if(option.key==='enable')throw new VideoFilterParseError('Lumakey timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported lumakey option');
 }
 return Object.freeze({name:'lumakey',...values});
}
/** config_input for depth 8: one double add and one multiply per bound, truncated to int, then av_clip_uint8; so is truncated. */
export function lumakeyBounds(step:LumakeyStep):{readonly white:number;readonly black:number;readonly so:number}{
 const clip=(value:number)=>{const truncated=Math.trunc(value);return truncated<0?0:truncated>255?255:truncated;};
 return {white:clip((step.threshold+step.tolerance)*255),black:clip((step.threshold-step.tolerance)*255),so:Math.trunc(step.softness*255)};
}
/** do_lumakey_slice8: alpha is rewritten from luma inside [black - so, white + so], kept elsewhere; Y, U and V are copied. Owned tight planes. */
export function lumakeyVideoFrame(frame:VideoFrameData,step:LumakeyStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 for(const name of names){const value=step[name];if(typeof value!=='number'||!(value>=0&&value<=1))throw new VideoLumakeyError('Invalid lumakey settings');}
 if(!executable.includes(frame.pixelFormat))throw new VideoLumakeyError('Lumakey pixel format is not supported');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoLumakeyError('Lumakey frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoLumakeyError('Invalid lumakey plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoLumakeyError('Invalid lumakey plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoLumakeyError('Lumakey input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoLumakeyError('Invalid lumakey timestamp time base');
 const {white:w,black:b,so}=lumakeyBounds(step),data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!;
  for(let y=0;y<plane.height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 }
 // yuva420p: plane 0 is luma and plane 3 alpha, both full size. so == 0 never reaches a division: b < l < w is inside the key.
 const luma=layout.planes[0]!,alpha=layout.planes[3]!;
 for(let y=0;y<luma.height;y++){
  signal?.throwIfAborted();const lumaRow=luma.offset+y*luma.rowBytes,alphaRow=alpha.offset+y*alpha.rowBytes;
  for(let x=0;x<luma.rowBytes;x++){
   const l=data[lumaRow+x]!;
   if(l>=b&&l<=w)data[alphaRow+x]=0;
   else if(l>b-so&&l<w+so)data[alphaRow+x]=l<b?255-((l-b+so)*255/so|0):(l-w)*255/so|0;
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands (threshold, tolerance, softness) are refused: the descriptor sets neither timeline nor geometryCommands. */
export const lumakeyOperator=defineVideoOperator<LumakeyStep>({name:'lumakey',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuva420p,lumakey','format=yuva420p,lumakey=0.5:0.2:0.1,hflip','format=yuva420p,lumakey=threshold=1:softness=1','format=yuva420p,lumakey=tolerance=1'],
 parse:(token:FilterToken)=>singlePad(parseLumakeyOptions(token.options)),
 formats:()=>lumakeyPixelFormats,
 frame:(frame,step,options)=>lumakeyVideoFrame(frame,step,options)});
