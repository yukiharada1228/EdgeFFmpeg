// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_colorcorrect.c. See ../../NOTICE-COLORCORRECT.
import {pixelLayout,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions,VideoShape} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoColorcorrectError extends Error {}
/** AnalyzeMode: manual, average, minmax and median. */
export const colorcorrectAnalyzeModes=Object.freeze(['manual','average','minmax','median'] as const);
export type ColorcorrectAnalyze=typeof colorcorrectAnalyzeModes[number];
/** rl, bl, rh, bh and saturation hold the single-precision values native stores. */
export type ColorcorrectStep={readonly name:'colorcorrect';readonly rl:number;readonly bl:number;readonly rh:number;readonly bh:number;readonly saturation:number;readonly analyze:ColorcorrectAnalyze};
/** The pinned pixel_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const colorcorrectPixelFormats:readonly string[]=Object.freeze('yuv420p yuv422p yuv440p yuv411p yuv444p yuva420p yuva422p yuva444p yuvj444p yuvj440p yuvj422p yuvj420p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv440p10le yuv444p10le yuv444p12le yuv422p12le yuv440p12le yuv420p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le'.split(' '));
/** The eight-bit members with frame storage here: yuv420p, yuv422p, yuv444p and yuva420p. */
const executable:readonly string[]=Object.freeze(colorcorrectPixelFormats.filter(executableFormat));
/** log2_chroma_w and log2_chroma_h of the executable formats. */
const chroma:Readonly<Record<string,readonly [number,number]>>={yuv420p:[1,1],yuv422p:[1,0],yuv444p:[0,0],yuva420p:[1,1]};
const names=['rl','bl','rh','bh','saturation','analyze'] as const;
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const f=Math.fround;
/** AV_OPT_TYPE_FLOAT: a constant decimal or default/max/min/none/all (first match wins, as in av_expr), range checked as a double, stored as float. */
function floatOption(key:string,text:string,low:number,high:number,fallback:number):number{
 const named:Readonly<Record<string,number>>={default:fallback,max:high,min:low,none:0,all:-1};
 const value=decimal.test(text)?Number(text):Object.hasOwn(named,text)?named[text]!:Number.NaN;
 if(Number.isNaN(value))throw new VideoFilterParseError(`Only constant decimal colorcorrect ${key} values are implemented`);
 if(!(value>=low&&value<=high))throw new VideoFilterParseError(`Invalid colorcorrect ${key}: value outside ${low}..${high}`);
 return f(value);
}
/** AV_OPT_TYPE_INT analyze: the unit constants, then default/max/min/none/all, or a decimal rounded with llrint after the 0..3 range check. */
function analyzeOption(text:string):ColorcorrectAnalyze{
 const named:Readonly<Record<string,number>>={manual:0,average:1,minmax:2,median:3,default:0,max:3,min:0,none:0,all:-1};
 let value:number;
 if(Object.hasOwn(named,text))value=named[text]!;else if(decimal.test(text))value=Number(text);
 else throw new VideoFilterParseError('Only constant colorcorrect analyze values are implemented');
 if(!(value>=0&&value<=3))throw new VideoFilterParseError('Invalid colorcorrect analyze: value outside 0..3');
 const lower=Math.floor(value),fraction=value-lower,mode=colorcorrectAnalyzeModes[fraction<0.5?lower:fraction>0.5?lower+1:lower%2===0?lower:lower+1]!;
 // average_slice8 divides per-slice float sums and averages the slices, so its result depends on the thread count.
 if(mode==='average')throw new VideoFilterParseError('Colorcorrect analyze=average is not implemented: its result depends on the native slice count');
 return mode;
}
/** colorcorrect_options applied in order (later occurrences win); enable= and every other option are refused. */
export function parseColorcorrectOptions(options:string|null):ColorcorrectStep{
 const values={rl:0,bl:0,rh:0,bh:0,saturation:1,analyze:'manual' as ColorcorrectAnalyze};
 for(const option of filterOptions(options,names)){
  if(option.key==='rl'||option.key==='bl'||option.key==='rh'||option.key==='bh')values[option.key]=floatOption(option.key,option.value,-1,1,0);
  else if(option.key==='saturation')values.saturation=floatOption('saturation',option.value,-3,3,1);
  else if(option.key==='analyze')values.analyze=analyzeOption(option.value);
  else if(option.key==='enable')throw new VideoFilterParseError('Colorcorrect timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported colorcorrect option');
 }
 return Object.freeze({name:'colorcorrect',...values});
}
/** analyze=minmax averages per-slice extremes over FFMIN(chroma height, threads) slices: only a one-row chroma plane is thread independent. */
function checkGeometry(step:ColorcorrectStep,format:string,height:number):void{
 // Formats without storage are refused by name in the shared negotiators.
 const shift=chroma[videoStoragePixelFormat(format)];if(!shift)return;
 if(step.analyze==='minmax'&&(height+(1<<shift[1])-1)>>shift[1]>1)throw new VideoColorcorrectError('Colorcorrect analyze=minmax is implemented only for one-row chroma planes: native averages per-slice extremes, which depends on the slice count');
}
const validStep=(step:ColorcorrectStep)=>[step.rl,step.bl,step.rh,step.bh].every(value=>typeof value==='number'&&value>=-1&&value<=1&&f(value)===value)&&typeof step.saturation==='number'&&step.saturation>=-3&&step.saturation<=3&&f(step.saturation)===step.saturation&&(step.analyze==='manual'||step.analyze==='minmax'||step.analyze==='median');
/** Width, height, the per-pixel scale and the analysis of filter_frame for depth 8. Every float operation is rounded to single precision, unfused. */
export function colorcorrectVideoFrame(frame:VideoFrameData,step:ColorcorrectStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(!validStep(step))throw new VideoColorcorrectError('Invalid colorcorrect settings');
 if(!executable.includes(frame.pixelFormat))throw new VideoColorcorrectError('Colorcorrect pixel format is not supported');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoColorcorrectError('Colorcorrect frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoColorcorrectError('Invalid colorcorrect plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoColorcorrectError('Invalid colorcorrect plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoColorcorrectError('Colorcorrect input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoColorcorrectError('Invalid colorcorrect timestamp time base');
 checkGeometry(step,frame.pixelFormat,frame.height);
 const data=new Uint8Array(layout.bytes),[chromaW,chromaH]=chroma[frame.pixelFormat]!,cw=1<<chromaW,ch=1<<chromaH,up=layout.planes[1]!,width=up.width,height=up.height;
 for(const [index,plane]of layout.planes.entries()){
  if(index===1||index===2)continue;const input=frame.planes[index]!,stride=frame.linesizes[index]!;
  for(let y=0;y<plane.height;y++){if((y&255)===0)signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 }
 const [yi,ui,vi]=frame.planes as unknown as readonly [Uint8Array,Uint8Array,Uint8Array],[ys,us,vs]=frame.linesizes as unknown as readonly [number,number,number];
 const max=255,imax=f(1/255);let {rl,bl,rh,bh}=step;
 if(step.analyze!=='manual'){
  // One slice: minmax_slice8 on a one-row chroma plane, or median_8 over the whole plane. analyzeret is imax * statistic - 0.5f.
  let minU=255,minV=255,maxU=0,maxV=0;const uh=new Uint32Array(256),vh=new Uint32Array(256);
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();
   for(let x=0;x<width;x++){const u=ui[y*us+x]!,v=vi[y*vs+x]!;if(u<minU)minU=u;if(v<minV)minV=v;if(u>maxU)maxU=u;if(v>maxV)maxV=v;uh[u]!++;vh[v]!++;}
  }
  if(step.analyze==='median'){
   const half=Math.trunc(width*height/2),median=(histogram:Uint32Array)=>{let count=0;for(let i=0;i<256;i++){count+=histogram[i]!;if(count>=half)return i;}return max;};
   minU=maxU=median(uh);minV=maxV=median(vh);
  }
  // bl += analyzeret (from 0.f), divided by one slice, then negated.
  const ret=(value:number)=>f(f(imax*value)-0.5);
  bl=-f(0+ret(minU));rl=-f(0+ret(minV));bh=-f(0+ret(maxU));rh=-f(0+ret(maxV));
 }
 const saturation=step.saturation,bd=f(bh-bl),rd=f(rh-rl),uo=up.offset,vo=layout.planes[2]!.offset;
 for(let y=0;y<height;y++){
  signal?.throwIfAborted();const yr=y*ch*ys,ur=y*us,vr=y*vs,ut=uo+y*width,vt=vo+y*width;
  for(let x=0;x<width;x++){
   if((x&4095)===0)signal?.throwIfAborted();
   const luma=f(yi[yr+x*cw]!*imax),u=f(f(ui[ur+x]!*imax)-0.5),v=f(f(vi[vr+x]!*imax)-0.5);
   const nu=f(saturation*f(f(u+f(luma*bd))+bl)),nv=f(saturation*f(f(v+f(luma*rd))+rl));
   // av_clip_uint8 of the float converted to int (truncation toward zero).
   const a=Math.trunc(f(f(nu+0.5)*max)),b=Math.trunc(f(f(nv+0.5)*max));
   data[ut+x]=a<0?0:a>255?255:a;data[vt+x]=b<0?0:b>255?255:b;
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const colorcorrectOperator=defineVideoOperator<ColorcorrectStep>({name:'colorcorrect',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuv444p,colorcorrect','format=yuv420p,colorcorrect=rl=0.1:bl=-0.2:rh=0.3:bh=-0.05:saturation=1.5','format=yuva420p,colorcorrect=analyze=median,hflip','format=yuv422p,colorcorrect=saturation=-1'],
 parse:(token:FilterToken)=>singlePad(parseColorcorrectOptions(token.options)),
 formats:()=>colorcorrectPixelFormats,
 geometry:(step,[input]:readonly VideoShape[])=>{if(!input)throw new VideoColorcorrectError('Colorcorrect needs one input');checkGeometry(step,input.format,input.height);return {width:input.width,height:input.height};},
 frame:(frame,step,options)=>colorcorrectVideoFrame(frame,step,options)});
