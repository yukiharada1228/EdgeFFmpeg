// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_il.c (il_options, config_input, interleave, filter_frame). See ../../NOTICE-IL.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions,VideoShape,VideoSize} from './descriptor.js';
import {filterBoolean} from './options.js';
export class VideoIlError extends Error {}
/** MODE_NONE, MODE_INTERLEAVE, MODE_DEINTERLEAVE. */
export type IlMode='none'|'interleave'|'deinterleave';
export interface IlPlaneSettings {readonly mode:IlMode;readonly swap:boolean}
export type IlStep={readonly name:'il';readonly luma:IlPlaneSettings;readonly chroma:IlPlaneSettings;readonly alpha:IlPlaneSettings};
const modes:Readonly<Record<string,IlMode>>={none:'none',interleave:'interleave',i:'interleave',deinterleave:'deinterleave',d:'deinterleave'},numbered:readonly IlMode[]=['none','interleave','deinterleave'];
const keys:Readonly<Record<string,readonly ['luma'|'chroma'|'alpha','mode'|'swap']>>={luma_mode:['luma','mode'],l:['luma','mode'],chroma_mode:['chroma','mode'],c:['chroma','mode'],alpha_mode:['alpha','mode'],a:['alpha','mode'],luma_swap:['luma','swap'],ls:['luma','swap'],chroma_swap:['chroma','swap'],cs:['chroma','swap'],alpha_swap:['alpha','swap'],as:['alpha','swap']};
/** AV_OPT_TYPE_INT with unit constants: the declared names or a plain decimal inside [MODE_NONE, MODE_DEINTERLEAVE]. */
function ilMode(value:string):IlMode{
 if(Object.hasOwn(modes,value))return modes[value]!;
 if(/^\d{1,9}$/.test(value)&&Number(value)<=2)return numbered[Number(value)]!;
 throw new VideoFilterParseError('Only declared il mode names and integers 0 to 2 are implemented');
}
/** Shorthand follows declaration order with aliases skipped, as avfilter process_options does. */
export function parseIlOptions(options:string|null):IlStep{
 const state={luma:{mode:'none' as IlMode,swap:false},chroma:{mode:'none' as IlMode,swap:false},alpha:{mode:'none' as IlMode,swap:false}};
 for(const option of filterOptions(options,['luma_mode','chroma_mode','alpha_mode','luma_swap','chroma_swap','alpha_swap'])){
  if(option.key==='enable')throw new VideoFilterParseError('Il timeline expressions are not implemented');
  const target=Object.hasOwn(keys,option.key)?keys[option.key]:undefined;if(!target)throw new VideoFilterParseError('Unsupported il option');
  if(target[1]==='mode')state[target[0]].mode=ilMode(option.value);
  else{try{state[target[0]].swap=filterBoolean(option.value);}catch{throw new VideoFilterParseError('Invalid il swap boolean');}}
 }
 return Object.freeze({name:'il',luma:Object.freeze(state.luma),chroma:Object.freeze(state.chroma),alpha:Object.freeze(state.alpha)});
}
const packedAlpha=['rgba','bgra','argb','abgr'];
/** filter_frame plane roles: plane 0 luma, then chroma, then the alpha plane. Packed RGBA has one plane that is
 * processed as luma and again as alpha, so the alpha settings win; that native quirk is kept. */
export function ilPlaneSettings(pixelFormat:string,step:IlStep):readonly IlPlaneSettings[]{
 const layout=pixelLayout(pixelFormat,2,2);if(!['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','gbrp',...packedAlpha].includes(layout.pixelFormat))throw new VideoIlError('Il pixel format is not supported');
 if(packedAlpha.includes(layout.pixelFormat))return [step.alpha];
 const alpha=layout.pixelFormat==='yuva420p';return layout.planes.map((_,index)=>index===0?step.luma:alpha&&index===layout.planes.length-1?step.alpha:step.chroma);
}
/** Native writes 2*(h>>1) rows per plane, so an odd plane height leaves a row from buffer-pool history. */
function checkHeights(pixelFormat:string,width:number,height:number):void{
 if(pixelLayout(pixelFormat,width,height).planes.some(plane=>plane.height%2))throw new VideoIlError('Il requires even heights in every processed plane');
}
function ilGeometry(step:IlStep,inputs:readonly VideoShape[]):VideoSize{
 const input=inputs[0];if(!input||inputs.length!==1)throw new VideoIlError('Il requires one input');ilPlaneSettings(input.format,step);checkHeights(input.format,input.width,input.height);return {width:input.width,height:input.height};
}
/** interleave() per plane into owned tight planes; MODE_NONE with swap exchanges each row pair. */
export function ilVideoFrame(frame:VideoFrameData,step:IlStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),settings=ilPlaneSettings(layout.pixelFormat,step);checkHeights(layout.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoIlError('Il frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoIlError('Invalid il plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoIlError('Invalid il plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoIlError('Il input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoIlError('Invalid il timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,{mode,swap}=settings[index]!,a=swap?1:0,b=1-a,m=plane.height>>1,w=plane.rowBytes;
  const copy=(target:number,source:number)=>{data.set(input.subarray(source*stride,source*stride+w),plane.offset+target*w);};
  for(let y=0;y<m;y++){
   signal?.throwIfAborted();
   if(mode==='deinterleave'){copy(y,y*2+a);copy(y+m,y*2+b);}
   else if(mode==='none'){copy(y*2,y*2+a);copy(y*2+1,y*2+b);}
   else{copy(y*2+a,y);copy(y*2+b,y+m);}
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** Native query_formats rejects only palette and hwaccel formats, so every table format negotiates. */
export const ilOperator=defineVideoOperator<IlStep>({name:'il',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['il','il=l=d:ls=1','il=luma_mode=interleave:c=i:luma_swap=1,hflip'],
 parse:token=>singlePad(parseIlOptions(token.options)),
 validate:(pixelFormat,step)=>{ilPlaneSettings(pixelFormat,step);},
 geometry:ilGeometry,
 frame:(frame,step,options)=>ilVideoFrame(frame,step,options)});
