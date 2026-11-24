// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_limiter.c. See ../../NOTICE-LIMITER.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export type LimiterStep={readonly name:'limiter';readonly min:number;readonly max:number;readonly planes:number};
/** The pinned pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth. A negotiated
 * format outside the executable table is refused at plan time. */
export const limiterPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit members with frame storage here. */
const executable:readonly string[]=Object.freeze(limiterPixelFormats.filter(executableFormat));
const ranges={min:{min:0,max:65535,defaultValue:0},max:{min:0,max:65535,defaultValue:65535},planes:{min:0,max:15,defaultValue:15}} as const;
/** AV_OPT_TYPE_INT options applied in order, then init's min > max refusal. */
export function parseLimiterOptions(options:string|null):LimiterStep{
 const values={min:0,max:65535,planes:15};
 for(const option of filterOptions(options,['min','max','planes'])){
  if(option.key==='min'||option.key==='max'||option.key==='planes'){
   try{values[option.key]=filterIntegerOption(option.value,ranges[option.key]);}catch(error){throw new VideoFilterParseError(`Invalid limiter ${option.key}: ${(error as Error).message}`);}
  }else if(option.key==='enable')throw new VideoFilterParseError('Limiter timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported limiter option');
 }
 if(values.min>values.max)throw new VideoFilterParseError('Limiter min must not exceed max');
 return Object.freeze({name:'limiter',...values});
}
/** filter_slice with config_input's 8-bit bound clamp; unmasked planes are copied. Owned tight planes. */
export function limitVideoFrame(frame:VideoFrameData,step:LimiterStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {min,max,planes}=step;
 if(!Number.isInteger(min)||!Number.isInteger(max)||!Number.isInteger(planes)||min<0||max>65535||min>max||planes<0||planes>15)throw new Error('Invalid limiter settings');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);if(!executable.includes(layout.pixelFormat))throw new Error('Limiter pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new Error('Limiter frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Invalid limiter plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid limiter plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new Error('Limiter input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid limiter timestamp time base');
 // Every supported layout has depth 8: config_input clamps both bounds to 255.
 const low=Math.min(min,255),high=Math.min(max,255),data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,active=(planes>>index&1)===1;
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const sourceRow=y*stride,targetRow=plane.offset+y*plane.rowBytes;
   if(!active){data.set(input.subarray(sourceRow,sourceRow+plane.rowBytes),targetRow);continue;}
   for(let x=0;x<plane.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();const value=input[sourceRow+x]!;data[targetRow+x]=value<low?low:value>high?high:value;}
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const limiterOperator=defineVideoOperator<LimiterStep>({name:'limiter',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['limiter','limiter=16:235','limiter=min=40:max=200:planes=1,hflip','limiter=300:planes=0'],
 parse:(token:FilterToken)=>singlePad(parseLimiterOptions(token.options)),
 formats:()=>limiterPixelFormats,
 frame:(frame,step,options)=>limitVideoFrame(frame,step,options)});
