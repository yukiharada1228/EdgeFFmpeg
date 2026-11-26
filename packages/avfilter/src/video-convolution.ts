// SPDX-License-Identifier: LGPL-2.1-or-later
// Matrix parsing, edge mirroring and the eight-bit square, row and column kernels adapted from pinned FFmpeg
// libavfilter/vf_convolution.c (param_init, filter_slice, filter_3x3/5x5/7x7/row/column, setup_*), convolution.h
// and libavutil/internal.h avpriv_mirror at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE-CONVOLUTION.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
import {filterIntegerOption} from './activation/integer-option.js';
export class VideoConvolutionError extends Error {}
export type ConvolutionMode='square'|'row'|'column';
/** One plane after param_init: the parsed matrix, its mode and taps, the resolved float rdiv and bias, and the identity copy flag. */
export interface ConvolutionPlane {readonly matrix:readonly number[];readonly mode:ConvolutionMode;readonly size:number;readonly rdiv:number;readonly bias:number;readonly copy:boolean}
export interface VideoConvolutionSettings {readonly planes:readonly [ConvolutionPlane,ConvolutionPlane,ConvolutionPlane,ConvolutionPlane]}
export interface VideoConvolutionOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** The pinned vf_convolution.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth. */
export const convolutionPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit members with frame storage here (the yuvj siblings run as legacy sources of linear chains). */
export const convolutionExecutableFormats:readonly string[]=Object.freeze(['yuv444p','yuvj444p','yuv422p','yuva420p','yuv420p','yuvj422p','yuvj420p','gbrp','gray']);
const modes:readonly ConvolutionMode[]=Object.freeze(['square','row','column']);
/** AV_OPT_TYPE_* options in native declaration order, which is also the shorthand order. */
export const convolutionOptionKeys=Object.freeze(['0m','1m','2m','3m','0rdiv','1rdiv','2rdiv','3rdiv','0bias','1bias','2bias','3bias','0mode','1mode','2mode','3mode'] as const);
const identity='0 0 0 0 1 0 0 0 0';
/** av_strtok on " |", then one sscanf("%d") per token, at most 49 tokens. Only plain decimal int32 tokens are accepted: native's
 * sscanf keeps a leading integer and ignores the rest, leaves a stale element for a non-numeric token and ignores tokens past 49. */
export function parseConvolutionMatrix(text:string,plane:number):readonly number[]{
 const tokens=text.split(/[ |]+/).filter(Boolean);
 if(tokens.length>49)throw new VideoConvolutionError(`Convolution matrix ${plane}m has more than 49 elements, which is not implemented`);
 const matrix=tokens.map(token=>{if(!/^[+-]?\d{1,10}$/.test(token))throw new VideoConvolutionError(`Only decimal integer convolution matrix elements are implemented: ${token}`);const value=Number(token);if(value<-2147483648||value>2147483647)throw new VideoConvolutionError(`Convolution matrix element outside the int range: ${token}`);return value||0;});
 if(!(matrix.length&1))throw new VideoConvolutionError('number of matrix elements must be odd');
 return Object.freeze(matrix);
}
/** param_init for one plane: float sum of the elements (1 when 0), rdiv = 1/sum when the user rdiv is 0, size from the mode. */
export function convolutionPlane(matrix:readonly number[],mode:ConvolutionMode,userRdiv:number,bias:number):ConvolutionPlane{
 let size:number;
 if(mode==='row'||mode==='column')size=matrix.length;
 else if(matrix.length===9)size=3;else if(matrix.length===25)size=5;else if(matrix.length===49)size=7;
 else throw new VideoConvolutionError(`Square convolution matrices need 9, 25 or 49 elements, not ${matrix.length}`);
 let sum=0;for(const value of matrix)sum=Math.fround(sum+Math.fround(value));if(sum===0)sum=1;
 const rdiv=userRdiv===0?Math.fround(1/sum):Math.fround(userRdiv),fbias=Math.fround(bias);
 // memcmp against same3x3/5x5/7x7: the centre tap alone is 1. The copy is kept only for rdiv 1 and bias 0.
 const copy=mode==='square'&&matrix.every((value,index)=>value===(index===matrix.length>>1?1:0))&&rdiv===1&&fbias===0;
 return Object.freeze({matrix,mode,size,rdiv,bias:fbias,copy});
}
/** AV_OPT_TYPE_FLOAT: constant decimal literals only; native compares the double with [0, INT_MAX], then stores a float. */
function floatOption(key:string,value:string):number{
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))throw new VideoConvolutionError(`Only constant decimal convolution ${key} values are implemented: ${value}`);
 const number=Number(value);if(!(number>=0&&number<=2147483647))throw new VideoConvolutionError(`Value ${value} for parameter '${key}' out of range [0 - 2.14748e+09]`);return Math.fround(number)||0;
}
export function parseConvolutionOptions(options:string|null):VideoConvolutionSettings{
 const matrices=[identity,identity,identity,identity],rdivs=[0,0,0,0],biases=[0,0,0,0],chosen:ConvolutionMode[]=['square','square','square','square'];
 for(const option of filterOptions(options,convolutionOptionKeys)){
  if(option.key==='enable')throw new VideoConvolutionError('Convolution timeline expressions are not implemented');
  const index=convolutionOptionKeys.indexOf(option.key as typeof convolutionOptionKeys[number]);if(index<0)throw new VideoConvolutionError(`Unsupported convolution option: ${option.key}`);
  const plane=index&3,kind=index>>2;
  if(kind===0)matrices[plane]=option.value;
  else if(kind===1)rdivs[plane]=floatOption(option.key,option.value);
  else if(kind===2)biases[plane]=floatOption(option.key,option.value);
  else{let value:number;try{value=filterIntegerOption(option.value,{min:0,max:2,defaultValue:0,constants:{square:0,row:1,column:2}});}catch{throw new VideoConvolutionError(`Invalid convolution ${option.key}`);}chosen[plane]=modes[value]!;}
 }
 // Native param_init validates all four planes whatever the format's plane count.
 const planes=[0,1,2,3].map(plane=>convolutionPlane(parseConvolutionMatrix(matrices[plane]!,plane),chosen[plane]!,rdivs[plane]!,biases[plane]!));
 return Object.freeze({planes:Object.freeze(planes) as unknown as VideoConvolutionSettings['planes']});
}
/** avpriv_mirror(x, w): reflect without repeating the edge sample, repeatedly for kernels wider than the plane. */
export function convolutionMirror(x:number,w:number):number{if(!w)return 0;while(x>>>0>w>>>0){x=-x;if(x<0)x+=2*w;}return x;}
function checkPlane(plane:ConvolutionPlane){
 const {matrix,mode,size,rdiv,bias,copy}=plane;
 if(!Array.isArray(matrix)||!(matrix.length&1)||matrix.length>49||matrix.some(value=>!Number.isInteger(value)||value<-2147483648||value>2147483647)||!modes.includes(mode)||typeof copy!=='boolean'||!Number.isFinite(rdiv)||Math.fround(rdiv)!==rdiv||!Number.isFinite(bias)||Math.fround(bias)!==bias||bias<0)throw new VideoConvolutionError('Invalid convolution settings');
 if(mode==='square'?size*size!==matrix.length:size!==matrix.length)throw new VideoConvolutionError('Invalid convolution settings');
}
function convolutionLayout(pixelFormat:string,width:number,height:number,settings:VideoConvolutionSettings){
 const layout=pixelLayout(pixelFormat,width,height);if(!convolutionExecutableFormats.includes(pixelFormat)||!convolutionExecutableFormats.includes(layout.pixelFormat))throw new VideoConvolutionError('Convolution pixel format is not supported');
 // param_init assigns no eight-bit filter to an identity square matrix, then clears the copy flag for rdiv != 1 or bias != 0:
 // native calls a null function pointer (SIGSEGV) on such a processed plane.
 for(const [index,plane]of settings.planes.slice(0,layout.planes.length).entries())if(plane.mode==='square'&&!plane.copy&&plane.matrix.every((value,i)=>value===(i===plane.matrix.length>>1?1:0)))throw new VideoConvolutionError(`Convolution identity matrix ${index}m with rdiv or bias is not implemented (native calls a null filter)`);
 return layout;
}
/** Geometry check shared by every path: an executable eight-bit layout and no native null-filter plane; any plane size is accepted (the edges mirror). */
export function convolutionGeometry(pixelFormat:string,width:number,height:number,settings:VideoConvolutionSettings):void{for(const plane of settings.planes)checkPlane(plane);convolutionLayout(pixelFormat,width,height,settings);}
/** av_clip_uint8((int)sum * rdiv + bias + 0.5f): unfused float operations, then the x86-64 cvttss2si conversion (INT_MIN when out of range). */
export function convolutionSample(sum:number,rdiv:number,bias:number):number{
 const value=Math.fround(Math.fround(Math.fround(Math.fround(sum)*rdiv)+bias)+0.5);
 const integer=value>=2147483648||value<-2147483648||Number.isNaN(value)?-2147483648:value|0;return integer<0?0:integer>255?255:integer;
}
/** filter_slice: copy planes, or the mirrored integer sum over the taps of each plane's mode. Output planes are owned and tight. */
export function convolveVideoFrame(frame:VideoFrameData,settings:VideoConvolutionSettings,options:VideoConvolutionOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(!Array.isArray(settings.planes)||settings.planes.length!==4)throw new VideoConvolutionError('Invalid convolution settings');for(const plane of settings.planes)checkPlane(plane);
 const layout=convolutionLayout(frame.pixelFormat,frame.width,frame.height,settings);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoConvolutionError('Convolution frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoConvolutionError('Invalid convolution plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoConvolutionError('Invalid convolution plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoConvolutionError('Convolution input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoConvolutionError('Invalid convolution timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,width=plane.width,height=plane.height,setting=settings.planes[index]!,target=plane.offset;
  if(setting.copy){for(let y=0;y<height;y++){signal?.throwIfAborted();data.set(src.subarray(y*stride,y*stride+width),target+y*width);}continue;}
  // Taps across (hx) and down (vy); the matrix is row-major. Row mode keeps the row, column mode keeps the column.
  const {matrix,rdiv,bias,mode,size}=setting,hx=mode==='column'?1:size,vy=mode==='row'?1:size,rx=hx>>1,ry=vy>>1,m=Int32Array.from(matrix);
  const mx=Int32Array.from({length:width+hx-1},(_,k)=>convolutionMirror(k-rx,width-1)),my=Int32Array.from({length:height+vy-1},(_,k)=>convolutionMirror(k-ry,height-1));
  const rows=new Int32Array(vy);
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();for(let j=0;j<vy;j++)rows[j]=my[y+j]!*stride;const out=target+y*width;
   for(let x=0;x<width;x++){
    if((x&4095)===0&&x)signal?.throwIfAborted();
    // unsigned sum += (unsigned)c[i][x] * matrix[i], read back as int.
    let sum=0;for(let j=0;j<vy;j++){const row=rows[j]!,base=j*hx;for(let i=0;i<hx;i++)sum=sum+Math.imul(src[row+mx[x+i]!]!,m[base+i]!)|0;}
    data[out+x]=convolutionSample(sum,rdiv,bias);
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
