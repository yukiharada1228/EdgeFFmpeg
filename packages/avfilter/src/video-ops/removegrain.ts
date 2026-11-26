// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_removegrain.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../../NOTICE-REMOVEGRAIN.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {removeGrainPlane,removeGrainSkips} from '../video-removegrain.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoRemoveGrainError extends Error {}
export type RemoveGrainStep={readonly name:'removegrain';readonly modes:readonly [number,number,number,number]};
/** The pinned vf_removegrain.c pix_fmts in declared order. A negotiated format outside the executable table is refused at plan time. */
export const removeGrainPixelFormats:readonly string[]=Object.freeze('gray yuv420p yuv422p yuv444p yuva420p yuva422p yuva444p yuv440p yuv411p yuv410p yuvj411p yuvj420p yuvj422p yuvj440p yuvj444p gbrp gbrap'.split(' '));
/** The members with frame storage here. */
const executable:readonly string[]=Object.freeze(removeGrainPixelFormats.filter(executableFormat));
const keys=['m0','m1','m2','m3'] as const;
/** AV_OPT_TYPE_INT m0..m3 (0..24, default 0) in native declaration order, which is also the shorthand order. */
export function parseRemoveGrainOptions(options:string|null):RemoveGrainStep{
 const modes:[number,number,number,number]=[0,0,0,0];
 for(const option of filterOptions(options,keys)){
  if(option.key==='enable')throw new VideoFilterParseError('Removegrain timeline expressions are not implemented');
  const index=(keys as readonly string[]).indexOf(option.key);if(index<0)throw new VideoFilterParseError('Unsupported removegrain option');
  try{modes[index]=filterIntegerOption(option.value,{min:0,max:24,defaultValue:0});}catch{throw new VideoFilterParseError(`Invalid removegrain ${option.key}`);}
 }
 return Object.freeze({name:'removegrain',modes:Object.freeze(modes)});
}
function checkStep(step:RemoveGrainStep):void{
 const {modes}=step;if(!Array.isArray(modes)||modes.length!==4||modes.some(mode=>!Number.isInteger(mode)||mode<0||mode>24))throw new VideoRemoveGrainError('Invalid removegrain settings');
}
function removeGrainLayout(pixelFormat:string,width:number,height:number){
 const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoRemoveGrainError('Removegrain pixel format is not supported');return layout;
}
/** filter_frame: per plane, mode 0 copies the plane; any other mode runs filter_slice between copied first and last rows. */
export function removeGrainVideoFrame(frame:VideoFrameData,step:RemoveGrainStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 const layout=removeGrainLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoRemoveGrainError('Removegrain frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoRemoveGrainError('Invalid removegrain plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoRemoveGrainError('Invalid removegrain plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoRemoveGrainError('Removegrain input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoRemoveGrainError('Invalid removegrain timestamp time base');
 const data=new Uint8Array(layout.bytes),skips=removeGrainSkips(step.modes,layout.planes.length);
 for(const [index,plane]of layout.planes.entries())removeGrainPlane(frame.planes[index]!,frame.linesizes[index]!,data,plane.offset,plane.width,plane.height,step.modes[index]!,skips,signal);
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** Stateless per-frame operator; enable= and runtime commands are refused. */
export const removegrainOperator=defineVideoOperator<RemoveGrainStep>({name:'removegrain',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['removegrain','removegrain=m0=1','removegrain=13:14:15:16,hflip','format=yuv444p,removegrain=m0=4:m1=17:m2=24','removegrain=20:0:0:0,vflip'],
 parse:token=>singlePad(parseRemoveGrainOptions(token.options)),
 formats:()=>removeGrainPixelFormats,
 geometry:(step,[input])=>{if(!input)throw new VideoRemoveGrainError('Removegrain needs one input');checkStep(step);removeGrainLayout(input.format,input.width,input.height);return {width:input.width,height:input.height};},
 frame:(frame,step,options)=>removeGrainVideoFrame(frame,step,options)});
