// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_deblock.c. See ../../NOTICE-DEBLOCK.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoDeblockError extends Error {}
export type DeblockFilter='weak'|'strong';
/** alpha..delta are the stored floats; ath..dth are config_output's float*max truncations for the eight-bit max 255. */
export type DeblockStep={readonly name:'deblock';readonly filter:DeblockFilter;readonly block:number;readonly alpha:number;readonly beta:number;readonly gamma:number;readonly delta:number;readonly planes:number;readonly thresholds:readonly [number,number,number,number]};
/** The pinned vf_deblock.c pixel_fmts in declared order (native-endian names); a negotiated format without storage here is refused at plan time. */
export const deblockPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit planar members with frame storage here: gray, yuv420p/422p/444p, yuva420p and gbrp. */
const executable:readonly string[]=Object.freeze(deblockPixelFormats.filter(executableFormat));
const keys=['filter','block','alpha','beta','gamma','delta','planes'],defaults={alpha:0.098,beta:0.05,gamma:0.05,delta:0.05};
/** AV_OPT_TYPE_FLOAT 0..1: the decimal double is range-checked, then stored as float. Expressions are not implemented. */
function floatOption(key:string,text:string):number{
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new VideoFilterParseError(`Only decimal deblock ${key} values are implemented`);
 const value=Number(text);if(!(value>=0&&value<=1))throw new VideoFilterParseError(`Invalid deblock ${key}: value outside range`);return Math.fround(value)||0;
}
const threshold=(value:number)=>Math.trunc(Math.fround(Math.fround(value)*255));
/** deblock_options: filter (weak/strong, default strong), block 4..512, alpha/beta/gamma/delta floats 0..1 and planes 0..15; enable= and threads are refused. */
export function parseDeblockOptions(options:string|null):DeblockStep{
 let filter:DeblockFilter='strong',block=8,planes=15;const floats:{alpha:number;beta:number;gamma:number;delta:number}={alpha:Math.fround(defaults.alpha),beta:Math.fround(defaults.beta),gamma:Math.fround(defaults.gamma),delta:Math.fround(defaults.delta)};
 for(const option of filterOptions(options,keys)){
  const integer=(min:number,max:number,defaultValue:number,constants:Record<string,number>={})=>{try{return filterIntegerOption(option.value,{min,max,defaultValue,constants});}catch(error){throw new VideoFilterParseError(`Invalid deblock ${option.key}: `+(error as Error).message);}};
  if(option.key==='filter')filter=integer(0,1,1,{weak:0,strong:1})?'strong':'weak';
  else if(option.key==='block')block=integer(4,512,8);
  else if(option.key==='planes')planes=integer(0,15,15);
  else if(option.key==='alpha'||option.key==='beta'||option.key==='gamma'||option.key==='delta')floats[option.key]=floatOption(option.key,option.value);
  else if(option.key==='enable')throw new VideoFilterParseError('Deblock timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported deblock option');
 }
 const {alpha,beta,gamma,delta}=floats;
 return Object.freeze({name:'deblock',filter,block,alpha,beta,gamma,delta,planes,thresholds:Object.freeze([threshold(alpha),threshold(beta),threshold(gamma),threshold(delta)] as [number,number,number,number])});
}
const checkStep=(step:DeblockStep)=>{
 if(step?.name!=='deblock'||(step.filter!=='weak'&&step.filter!=='strong')||!Number.isInteger(step.block)||step.block<4||step.block>512||!Number.isInteger(step.planes)||step.planes<0||step.planes>15||!Array.isArray(step.thresholds)||step.thresholds.length!==4||step.thresholds.some(value=>!Number.isInteger(value)||value<0||value>255))throw new VideoDeblockError('Invalid deblock settings');
};
/** config_output plane sizes. The vertical-edge kernels read one (weak) or two (strong) samples to the right of each edge column,
 * so an edge within that reach of a filtered plane's right border reads and writes past the row in native; those widths are refused. */
function deblockLayout(pixelFormat:string,width:number,height:number,step:DeblockStep){
 checkStep(step);const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoDeblockError('Deblock pixel format is not supported');
 const reach=step.filter==='weak'?1:2,{block}=step;
 if(layout.planes.some((plane,index)=>(step.planes>>index&1)&&plane.width>block&&(plane.width%block||block)<=reach))throw new VideoDeblockError('Deblock edges next to the right plane border read outside the plane and are not implemented');
 return layout;
}
type Kernel=(d:Uint8Array,p:number,ls:number,count:number,t:readonly [number,number,number,number])=>void;
const clip=(v:number)=>v<0?0:v>255?255:v,abs=Math.abs;
/** deblockh8_weak / deblockv8_weak: s is the sample distance across the edge, a the distance along it.
 * The native vertical kernels advance dst at the end of the loop body, which continue skips: after the first skipped row every
 * remaining iteration re-tests that unchanged row and skips again, so the vertical kernels stop there. */
const weak=(across:boolean):Kernel=>(d,p,ls,count,[ath,bth,gth])=>{
 const s=across?ls:1,a=across?1:ls;
 for(let i=0;i<count;i++,p+=a){
  const delta=d[p]!-d[p-s]!;
  if(abs(delta)>=ath||abs(d[p-s]!-d[p-2*s]!)>=bth||abs(d[p]!-d[p+s]!)>=gth){if(across)continue;break;}
  const A=d[p-2*s]!,B=d[p-s]!,C=d[p]!,D=d[p+s]!,d8=Math.trunc(delta/8),d2=Math.trunc(delta/2);
  d[p-2*s]=clip(A+d8);d[p-s]=clip(B+d2);d[p]=clip(C-d2);d[p+s]=clip(D-d8);
 }
};
/** deblockh8_strong / deblockv8_strong, with the same vertical stop. */
const strong=(across:boolean):Kernel=>(d,p,ls,count,[ath,bth,gth,dth])=>{
 const s=across?ls:1,a=across?1:ls;
 for(let i=0;i<count;i++,p+=a){
  const delta=d[p]!-d[p-s]!;
  if(abs(delta)>=ath||abs(d[p-s]!-d[p-2*s]!)>=bth||abs(d[p+s]!-d[p+2*s]!)>=gth||abs(d[p]!-d[p+s]!)>=dth){if(across)continue;break;}
  const A=d[p-3*s]!,B=d[p-2*s]!,C=d[p-s]!,D=d[p]!,E=d[p+s]!,F=d[p+2*s]!,d8=Math.trunc(delta/8),d4=Math.trunc(delta/4),d2=Math.trunc(delta/2);
  d[p-3*s]=clip(A+d8);d[p-2*s]=clip(B+d4);d[p-s]=clip(C+d2);d[p]=clip(D-d2);d[p+s]=clip(E-d4);d[p+2*s]=clip(F-d8);
 }
};
const kernels={weak:{h:weak(true),v:weak(false)},strong:{h:strong(true),v:strong(false)}};
/** filter_frame's block loop over one tight plane, in native order, including its frame-border skips: no vertical edge at x=0,
 * no horizontal edge at y=0, and none at the last block row at or below height-block. */
function deblockPlane(d:Uint8Array,o:number,w:number,h:number,step:DeblockStep,signal?:AbortSignal):void{
 const {block,thresholds:t}=step,{h:hk,v:vk}=kernels[step.filter],min=Math.min;let r=o,y:number;
 for(let x=block;x<w;x+=block)vk(d,r+x,w,min(block,h),t);
 for(y=block;y<h-block;y+=block){
  signal?.throwIfAborted();r+=w*block;hk(d,r,w,min(block,w),t);
  for(let x=block;x<w;x+=block){hk(d,r+x,w,min(block,w-x),t);vk(d,r+x,w,min(block,h-y),t);}
 }
 r+=w*block;for(let x=block;x<w;x+=block)vk(d,r+x,w,min(block,h-y),t);
}
/** Copy into owned tight planes, then deblock the selected planes; the input frame is never written. */
export function deblockVideoFrame(frame:VideoFrameData,step:DeblockStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=deblockLayout(frame.pixelFormat,frame.width,frame.height,step);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoDeblockError('Deblock frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoDeblockError('Invalid deblock plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoDeblockError('Invalid deblock plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoDeblockError('Deblock input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoDeblockError('Invalid deblock timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!;
  for(let y=0;y<plane.height;y++){if((y&255)===0)signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
  if(step.planes>>index&1)deblockPlane(data,plane.offset,plane.width,plane.height,step,signal);
 }
 signal?.throwIfAborted();
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** Runtime commands and enable= are refused; the edge-reach refusal depends on the negotiated plane widths. */
export const deblockOperator=defineVideoOperator<DeblockStep>({name:'deblock',role:'frame',paths:['linear','graph','stream','actor','timed'],
 examples:['deblock','deblock=block=4','deblock=filter=weak:block=4:alpha=1:beta=1:gamma=1,hflip','deblock=strong:4:1:1:1:1:1','deblock=block=512:planes=0'],
 parse:token=>singlePad(parseDeblockOptions(token.options)),
 formats:()=>deblockPixelFormats,
 geometry:(step,[input])=>{if(!input)throw new VideoDeblockError('Deblock needs one input');deblockLayout(input.format,input.width,input.height,step);return {width:input.width,height:input.height};},
 frame:(frame,step,options)=>deblockVideoFrame(frame,step,options)});
