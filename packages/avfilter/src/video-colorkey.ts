// SPDX-License-Identifier: LGPL-2.1-or-later
// do_colorkey_pixel, the colorkey/colorhold slices, config_output, the options and pixel_fmts adapted from pinned FFmpeg
// libavfilter/vf_colorkey.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE-COLORKEY.
import {ColorParseError,parseColor,pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
export class VideoColorkeyError extends Error {}
export type ColorkeyName='colorkey'|'colorhold';
export interface VideoColorkeySettings {readonly name:ColorkeyName;readonly color:readonly [number,number,number,number];readonly similarity:number;readonly blend:number}
export interface VideoColorkeyOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** The shared pinned pixel_fmts in declared order (native-endian names). Only the four packed 8-bit orders have frame storage here. */
export const colorkeyPixelFormats:readonly string[]=Object.freeze(['argb','rgba','abgr','bgra','rgba64le','bgra64le']);
/** ff_fill_rgba_map byte offsets of R, G, B and A. */
const maps:Readonly<Record<string,readonly [number,number,number,number]>>={rgba:[0,1,2,3],bgra:[2,1,0,3],argb:[1,2,3,0],abgr:[3,2,1,0]};
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** AV_OPT_TYPE_FLOAT: the double is range-checked, then stored as float. Expressions, suffixes and constants are not implemented. */
function floatOption(name:ColorkeyName,key:'similarity'|'blend',text:string,min:number,max:number):number{
 if(!decimal.test(text))throw new VideoColorkeyError(`Only decimal ${name} ${key} values are implemented`);
 const value=Number(text);if(!(value>=min&&value<=max))throw new VideoColorkeyError(`Value ${value.toFixed(6)} for parameter '${key}' out of range [${min===0?0:'1e-05'} - 1]`);
 return Math.fround(value);
}
/** AV_OPT_TYPE_COLOR through the shared av_parse_color port; random and platform-undefined colours are refused. */
function colorOption(name:ColorkeyName,text:string):readonly [number,number,number,number]{
 try{return parseColor(text);}catch(error){
  if(error instanceof ColorParseError)throw new VideoColorkeyError(error.code==='invalid'?error.message:`Unsupported ${name} color: ${error.message}`);throw error;
 }
}
/** Options in order, later occurrences win. enable= (the generic timeline) and every other option are refused. */
export function parseColorkeyOptions(name:ColorkeyName,options:string|null):VideoColorkeySettings{
 let color=parseColor('black'),similarity=Math.fround(0.01),blend=0;
 for(const option of filterOptions(options,['color','similarity','blend'])){
  if(option.key==='color')color=colorOption(name,option.value);
  else if(option.key==='similarity')similarity=floatOption(name,'similarity',option.value,0.00001,1);
  else if(option.key==='blend')blend=floatOption(name,'blend',option.value,0,1);
  else if(option.key==='enable')throw new VideoColorkeyError(`${name} timeline expressions are not implemented`);
  else throw new VideoColorkeyError(`Unsupported ${name} option`);
 }
 return Object.freeze({name,color,similarity,blend});
}
/** do_colorkey_pixel at depth 8 (max 255, scale 1.0) in unfused IEEE double; iblend is the float 1.f/blend. */
function keyValue(cr:number,cg:number,cb:number,r:number,g:number,b:number,similarity:number,iblend:number):number{
 const dr=r*1.0-cr,dg=g*1.0-cg,db=b*1.0-cb,diff=Math.sqrt((dr*dr+dg*dg+db*db)/(255.0*255.0*3.0));
 if(iblend<10000.0){const value=(diff-similarity)*iblend;return Math.trunc((value<0?0:value>1?1:value)*255);}
 return diff>similarity?255:0;
}
function validSettings(settings:VideoColorkeySettings):boolean{
 const {name,color,similarity,blend}=settings;
 return (name==='colorkey'||name==='colorhold')&&Array.isArray(color)&&color.length===4&&color.every(value=>Number.isInteger(value)&&value>=0&&value<=255)&&
  Math.fround(similarity)===similarity&&similarity>=Math.fround(0.00001)&&similarity<=1&&Math.fround(blend)===blend&&blend>=0&&blend<=1;
}
/** do_colorkey_slice8 / do_colorhold_slice8 over the whole frame into owned tight planes; the input is never mutated. */
export function colorkeyVideoFrame(frame:VideoFrameData,settings:VideoColorkeySettings,options:VideoColorkeyOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(!validSettings(settings))throw new VideoColorkeyError('Invalid colorkey settings');
 const map=Object.hasOwn(maps,frame.pixelFormat)?maps[frame.pixelFormat]:undefined;if(!map)throw new VideoColorkeyError(`${settings.name} pixel format is not supported`);
 const {width,height}=frame,layout=pixelLayout(frame.pixelFormat,width,height),rowBytes=width*4;
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoColorkeyError(`${settings.name} frame exceeds allocation limit`);
 if(frame.planes.length!==1||frame.linesizes.length!==1)throw new VideoColorkeyError(`Invalid ${settings.name} plane count`);
 const input=frame.planes[0],stride=frame.linesizes[0];
 if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(height-1)+BigInt(rowBytes))throw new VideoColorkeyError(`Invalid ${settings.name} plane stride or storage`);
 if(input.length>maxFrameBytes)throw new VideoColorkeyError(`${settings.name} input plane storage exceeds allocation limit`);
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoColorkeyError(`Invalid ${settings.name} timestamp time base`);
 const [ro,go,bo,ao]=map,[cr,cg,cb]=settings.color,similarity=settings.similarity,iblend=Math.fround(1/settings.blend),hold=settings.name==='colorhold',data=new Uint8Array(layout.bytes);
 for(let y=0;y<height;y++){
  signal?.throwIfAborted();const row=y*stride!,target=y*rowBytes;data.set(input.subarray(row,row+rowBytes),target);
  for(let o=target;o<target+rowBytes;o+=4){
   const r=data[o+ro]!,g=data[o+go]!,b=data[o+bo]!,t=keyValue(cr,cg,cb,r,g,b,similarity,iblend);
   if(!hold){data[o+ao]=t;continue;}
   // COLORHOLD_SLICE(8): a and rt are int, half is max / 2, the shift is depth.
   if(t>0){const a=Math.trunc((r+g+b)/3),rt=255-t;data[o+ro]=(a*t+r*rt+127)>>8;data[o+go]=(a*t+g*rt+127)>>8;data[o+bo]=(a*t+b*rt+127)>>8;}
  }
 }
 return {width,height,pixelFormat:layout.pixelFormat,planes:[data],linesizes:[rowBytes],pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
