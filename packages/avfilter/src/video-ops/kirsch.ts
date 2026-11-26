// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_convolution.c (filter_kirsch, setup_3x3, filter_slice, param_init). See ../../NOTICE-KIRSCH.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
/** planes is the AV_OPT_TYPE_INT mask; scale and delta are the AV_OPT_TYPE_FLOAT values as stored (float). */
export type KirschStep={readonly name:'kirsch';readonly planes:number;readonly scale:number;readonly delta:number};
export class VideoKirschError extends Error {}
/** The pinned vf_convolution.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * A negotiated format outside the executable table is refused at plan time. */
export const kirschPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit planar members with frame storage here (legacy yuvj links reach frames as their storage formats). */
const executable:readonly string[]=Object.freeze(kirschPixelFormats.filter(executableFormat));
/** common_options in declaration order, which is also the shorthand order. */
const keys=['planes','scale','delta'] as const;
/** AV_OPT_TYPE_FLOAT: the double is range-checked, then stored as float. Only decimal literals are implemented. */
function floatValue(key:string,text:string,min:number,max:number):number{
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new VideoFilterParseError(`Only decimal kirsch ${key} values are implemented`);
 const value=Number(text);if(!(value>=min&&value<=max))throw new VideoFilterParseError(`Kirsch ${key} must be within [${min},${max}]`);
 return Math.fround(value);
}
export function parseKirschOptions(options:string|null):KirschStep{
 let planes=15,scale=1,delta=0;
 for(const option of filterOptions(options,keys)){
  if(option.key==='enable')throw new VideoFilterParseError('Kirsch timeline expressions are not implemented');
  if(option.key==='planes'){try{planes=filterIntegerOption(option.value,{min:0,max:15,defaultValue:15});}catch{throw new VideoFilterParseError('Invalid kirsch planes');}}
  else if(option.key==='scale')scale=floatValue('scale',option.value,0,65535);
  else if(option.key==='delta')delta=floatValue('delta',option.value,-65535,65535);
  else throw new VideoFilterParseError('Unsupported kirsch option');
 }
 return Object.freeze({name:'kirsch',planes,scale,delta});
}
function kirschLayout(pixelFormat:string,width:number,height:number){
 const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoKirschError('Kirsch pixel format is not supported');return layout;
}
const isFloat=(value:number,min:number,max:number)=>typeof value==='number'&&Math.fround(value)===value&&value>=min&&value<=max;
function checkStep(step:KirschStep){if(step?.name!=='kirsch'||!Number.isInteger(step.planes)||step.planes<0||step.planes>15||!isFloat(step.scale,0,65535)||!isFloat(step.delta,-65535,65535))throw new VideoKirschError('Invalid kirsch settings');}
/** filter_slice with setup_3x3 and filter_kirsch: the eight neighbours come from avpriv_mirror (-1 -> 1, n -> n-2, a single
 * row or column -> 0). Each compass sum is 8*(its three 5-weighted taps) - 3*(all eight); the largest one's magnitude goes
 * through av_clip_uint8(|sum|*scale + delta) in unfused float with truncation. Planes outside the mask are copied. */
export function kirschVideoFrame(frame:VideoFrameData,step:KirschStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 const layout=kirschLayout(frame.pixelFormat,frame.width,frame.height),{planes:mask,scale,delta}=step;
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoKirschError('Kirsch frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoKirschError('Invalid kirsch plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoKirschError('Invalid kirsch plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoKirschError('Kirsch input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoKirschError('Invalid kirsch timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,width=plane.width,height=plane.height,filtered=(mask>>index&1)===1;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const row=y*stride,target=plane.offset+y*width;
   if(!filtered){data.set(src.subarray(row,row+width),target);continue;}
   const up=(y>0?y-1:Math.min(1,height-1))*stride,down=(y<height-1?y+1:Math.max(height-2,0))*stride;
   for(let x=0;x<width;x++){
    if((x&16383)===0&&x)signal?.throwIfAborted();
    const l=x>0?x-1:Math.min(1,width-1),r=x<width-1?x+1:Math.max(width-2,0);
    const c0=src[up+l]!,c1=src[up+x]!,c2=src[up+r]!,c3=src[row+l]!,c5=src[row+r]!,c6=src[down+l]!,c7=src[down+x]!,c8=src[down+r]!,all=3*(c0+c1+c2+c3+c5+c6+c7+c8);
    const sum=Math.max(8*(c0+c1+c2),8*(c1+c2+c3),8*(c2+c3+c5),8*(c3+c5+c6),8*(c5+c6+c7),8*(c6+c7+c8),8*(c0+c7+c8),8*(c0+c1+c8))-all;
    // int * float and float + float round to float separately (x86-64 baseline); the conversion to int truncates.
    const value=Math.trunc(Math.fround(Math.fround(Math.abs(sum)*scale)+delta));data[target+x]=value<0?0:value>255?255:value;
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** Stateless per-frame operator; enable= and runtime commands are refused. */
export const kirschOperator=defineVideoOperator<KirschStep>({name:'kirsch',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['kirsch','kirsch=planes=1:scale=0.5:delta=-20','kirsch=3:2:10,hflip','format=yuv444p,kirsch=planes=6'],
 parse:token=>singlePad(parseKirschOptions(token.options)),
 formats:()=>kirschPixelFormats,
 geometry:(_step,[input])=>{if(!input)throw new VideoKirschError('Kirsch needs one input');kirschLayout(input.format,input.width,input.height);return {width:input.width,height:input.height};},
 frame:(frame,step,options)=>kirschVideoFrame(frame,step,options)});
