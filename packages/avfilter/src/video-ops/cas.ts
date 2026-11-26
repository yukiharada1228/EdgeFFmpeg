// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_cas.c and libavutil/opt.c. See ../../NOTICE-CAS.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoCasError extends Error {}
/** strength is the stored float; planes the stored int of AV_OPT_TYPE_FLAGS. */
export type CasStep={readonly name:'cas';readonly strength:number;readonly planes:number};
/** The pinned vf_cas.c pixel_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const casPixelFormats:readonly string[]=Object.freeze('gray gray9le gray10le gray12le gray14le gray16le yuv410p yuv411p yuv420p yuv422p yuv440p yuv444p yuvj420p yuvj422p yuvj440p yuvj444p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv444p12le yuv422p12le yuv420p12le yuv440p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le yuva420p yuva422p yuva444p yuva444p9le yuva444p10le yuva444p12le yuva444p16le yuva422p9le yuva422p10le yuva422p12le yuva422p16le yuva420p9le yuva420p10le yuva420p16le gbrap gbrap10le gbrap12le gbrap16le'.split(' '));
/** The eight-bit planar members with frame storage here (cas_slice8 only). */
const executable:readonly string[]=Object.freeze(casPixelFormats.filter(executableFormat));
const integer=(value:string)=>/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(value)?Number(value):NaN;
/** AV_OPT_TYPE_FLOAT in [0,1]: the decimal double is range-checked, then stored as float. Expressions and constants are not implemented. */
function strengthValue(value:string):number{
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))throw new VideoFilterParseError('Only decimal cas strength values are implemented');
 const n=Number(value);if(!(n>=0&&n<=1))throw new VideoFilterParseError(`Cas strength ${value} is outside [0 - 1]`);return Math.fround(n);
}
/** AV_OPT_TYPE_FLAGS without a unit: +/- folded integer terms; write_number does not enforce the declared [0,15] range for flags. */
function planeFlags(value:string,current:number):number{
 if(value===''||value.length>255)throw new VideoFilterParseError('Only bounded nonempty cas plane flags are implemented');
 let position=0;
 for(;;){
  let command='';if(value[position]==='+'||value[position]==='-')command=value[position++]!;
  let end=position;while(end<value.length&&value[end]!=='+'&&value[end]!=='-')end++;
  const term=integer(value.slice(position,end));
  if(!Number.isSafeInteger(term)||term>0xffffffff)throw new VideoFilterParseError('Only decimal or hexadecimal integer cas plane flags up to 4294967295 are implemented');
  const intnum=current>>>0,d=command==='+'?Number(BigInt(intnum)|BigInt(term)):command==='-'?Number(BigInt(intnum)&~BigInt(term)):term;
  if(d>0xffffffff)throw new VideoFilterParseError('Cas planes are not a valid set of 32bit integer flags');
  current=d|0;position=end;if(position>=value.length)return current;
 }
}
/** cas_options in AVOption order: strength (FLOAT, 0) and planes (FLAGS, 7). */
export function parseCasOptions(options:string|null):CasStep{
 let strength=0,planes=7;
 for(const option of filterOptions(options,['strength','planes'])){
  switch(option.key){
   case 'strength':strength=strengthValue(option.value);break;
   case 'planes':planes=planeFlags(option.value,planes);break;
   case 'enable':throw new VideoFilterParseError('Cas timeline expressions are not implemented');
   default:throw new VideoFilterParseError('Unsupported cas option');
  }
 }
 return Object.freeze({name:'cas',strength,planes});
}
const checkStep=(step:CasStep)=>{if(step?.name!=='cas'||typeof step.strength!=='number'||!(step.strength>=0&&step.strength<=1)||Math.fround(step.strength)!==step.strength||!Number.isInteger(step.planes)||step.planes!==(step.planes|0))throw new VideoCasError('Invalid cas settings');};
function casLayout(pixelFormat:string,width:number,height:number,step:CasStep){
 checkStep(step);const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoCasError('Cas pixel format is not supported');return layout;
}
const F=Math.fround;
/** -lerpf(16.f, 4.01f, strength), every float operation rounded as in the unfused x86-64 build. */
export const casStrength=(strength:number)=>-F(16+F(F(F(4.01)-16)*F(strength)));
/** cas_slice8 per sample (a..i is the row-major 3x3 neighbourhood, e the centre): integer min/max sums, then single-precision amp,
 * weight and weighted mean, truncated by the implicit float-to-int conversion of av_clip_uint8 and clipped. FFMIN(FFMAX(q,0),1)
 * turns the NaN quotient of an all-zero neighbourhood (mx==0) into 0. */
export function casSample(a:number,b:number,c:number,d:number,e:number,f:number,g:number,h:number,i:number,strength:number):number{
 const mn=Math.min(d,e,f,b,h),mx=Math.max(d,e,f,b,h),mnSum=mn+Math.min(mn,a,c,g,i),mxSum=mx+Math.max(mx,a,c,g,i);
 const q=F(Math.min(mnSum,511-mxSum)/mxSum),clipped=q>0?q>1?1:q:0,amp=F(Math.sqrt(clipped)),weight=F(amp/strength);
 const r=Math.trunc(F(F(F((b+d+f+h)*weight)+e)/F(1+F(4*weight))));return r<0?0:r>255?255:r;
}
/** filter_frame with cas_slice8: clamped 3x3 neighbourhood per selected plane, unselected planes copied, into owned tight planes. */
export function casVideoFrame(frame:VideoFrameData,step:CasStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=casLayout(frame.pixelFormat,frame.width,frame.height,step);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoCasError('Cas frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoCasError('Invalid cas plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoCasError('Invalid cas plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoCasError('Cas input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoCasError('Invalid cas timestamp time base');
 const data=new Uint8Array(layout.bytes),strength=casStrength(step.strength);
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,{width,height}=plane,w1=width-1,h1=height-1;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const row=y*stride,target=plane.offset+y*width;
   if(!(step.planes>>index&1)){data.set(src.subarray(row,row+width),target);continue;}
   const up=(y>0?y-1:0)*stride,down=(y<h1?y+1:h1)*stride;
   for(let x=0;x<width;x++){
    if((x&16383)===16383)signal?.throwIfAborted();
    const x0=x>0?x-1:0,x1=x<w1?x+1:w1;
    data[target+x]=casSample(src[up+x0]!,src[up+x]!,src[up+x1]!,src[row+x0]!,src[row+x]!,src[row+x1]!,src[down+x0]!,src[down+x]!,src[down+x1]!,strength);
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
export const casOperator=defineVideoOperator<CasStep>({name:'cas',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['cas','cas=0.5:3,hflip','cas=strength=1:planes=0','format=yuv420p,cas=planes=0x6'],
 parse:token=>singlePad(parseCasOptions(token.options)),
 formats:()=>casPixelFormats,
 geometry:(step,[input])=>{casLayout(input!.format,input!.width,input!.height,step);return {width:input!.width,height:input!.height};},
 frame:(frame,step,options)=>casVideoFrame(frame,step,options)});
