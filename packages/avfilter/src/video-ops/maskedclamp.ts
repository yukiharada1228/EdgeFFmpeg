// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_maskedclamp.c. See ../../NOTICE-MASKEDCLAMP.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator} from './descriptor.js';
import type {VideoFrameOptions,VideoShape} from './descriptor.js';
import {executableFormat} from './formats.js';
/** shortest is the join role contract: maskedclamp declares no framesync options (AVFILTER_DEFINE_CLASS), so it is always false. */
export type MaskedclampStep={readonly name:'maskedclamp';readonly undershoot:number;readonly overshoot:number;readonly planes:number;readonly shortest:false};
/** The pinned pix_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const maskedclampPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit members with frame storage here. */
const executable:readonly string[]=Object.freeze(maskedclampPixelFormats.filter(executableFormat));
const ranges={undershoot:{min:0,max:65535,defaultValue:0},overshoot:{min:0,max:65535,defaultValue:0},planes:{min:0,max:15,defaultValue:15}} as const;
/** AV_OPT_TYPE_INT options applied in order; enable= and every framesync option are refused. */
export function parseMaskedclampOptions(options:string|null):MaskedclampStep{
 const values={undershoot:0,overshoot:0,planes:15};
 for(const option of filterOptions(options,['undershoot','overshoot','planes'])){
  if(option.key==='undershoot'||option.key==='overshoot'||option.key==='planes'){
   try{values[option.key]=filterIntegerOption(option.value,ranges[option.key]);}catch(error){throw new VideoFilterParseError(`Invalid maskedclamp ${option.key}: ${(error as Error).message}`);}
  }else if(option.key==='enable')throw new VideoFilterParseError('Maskedclamp timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported maskedclamp option');
 }
 return Object.freeze({name:'maskedclamp',...values,shortest:false});
}
const pads=(token:FilterToken):FilterPads<MaskedclampStep>=>({inputs:3,outputs:1,configuration:parseMaskedclampOptions(token.options)});
/** config_output: base, dark and bright must share one size; the shared format comes from ff_set_common_formats. */
export function maskedclampGeometry(inputs:readonly VideoShape[]){
 if(inputs.length!==3)throw new Error('Maskedclamp requires three inputs');
 const [base,dark,bright]=inputs as [VideoShape,VideoShape,VideoShape];
 if(base.width!==dark.width||base.height!==dark.height||base.width!==bright.width||base.height!==bright.height)throw new Error(`Maskedclamp input sizes differ: base ${base.width}x${base.height}, dark ${dark.width}x${dark.height}, bright ${bright.width}x${bright.height}`);
 if(inputs.some(input=>input.format!==base.format))throw new Error('Maskedclamp input formats differ');
 return {width:base.width,height:base.height};
}
/** process_frame and maskedclamp_slice with maskedclamp8: max against dark-undershoot, then min against bright+overshoot, so bright wins
 * when the two bounds cross. Unmasked planes copy base. Owned tight planes; props and metadata come from base. */
export function maskedclampVideoFrames(frames:readonly VideoFrameData[],step:MaskedclampStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {undershoot,overshoot,planes}=step;
 if(!Number.isInteger(undershoot)||!Number.isInteger(overshoot)||!Number.isInteger(planes)||undershoot<0||undershoot>65535||overshoot<0||overshoot>65535||planes<0||planes>15||step.shortest!==false)throw new Error('Invalid maskedclamp settings');
 if(frames.length!==3)throw new Error('Maskedclamp requires three frames');
 const base=frames[0]!;maskedclampGeometry(frames.map(frame=>({format:frame.pixelFormat,width:frame.width,height:frame.height})));
 const layout=pixelLayout(base.pixelFormat,base.width,base.height);if(!executable.includes(layout.pixelFormat))throw new Error('Maskedclamp pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new Error('Maskedclamp frame exceeds allocation limit');
 for(const frame of frames){
  if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Invalid maskedclamp plane count');
  let resident=0n;
  for(const [index,plane]of layout.planes.entries()){
   const input=frame.planes[index],stride=frame.linesizes[index];
   if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid maskedclamp plane stride or storage');
   resident+=BigInt(input.length);
  }
  if(resident>BigInt(maxFrameBytes))throw new Error('Maskedclamp input plane storage exceeds allocation limit');
  if(frame.pts&&(typeof frame.pts.value!=='bigint'||frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid maskedclamp timestamp time base');
 }
 // Every supported layout has depth 8: config_input's (1 << depth) - 1 bound clamp cannot change an eight-bit result.
 const low=Math.min(undershoot,255),high=Math.min(overshoot,255),data=new Uint8Array(layout.bytes),[,dark,bright]=frames as [VideoFrameData,VideoFrameData,VideoFrameData];
 for(const [index,plane]of layout.planes.entries()){
  const b=base.planes[index]!,d=dark.planes[index]!,l=bright.planes[index]!,bs=base.linesizes[index]!,ds=dark.linesizes[index]!,ls=bright.linesizes[index]!,active=(planes>>index&1)===1;
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const row=y*bs,target=plane.offset+y*plane.rowBytes;
   if(!active){data.set(b.subarray(row,row+plane.rowBytes),target);continue;}
   const dr=y*ds,lr=y*ls;
   for(let x=0;x<plane.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();const floor=d[dr+x]!-low,value=Math.max(b[row+x]!,floor),ceiling=l[lr+x]!+high;data[target+x]=value<ceiling?value:ceiling;}
  }
 }
 // The sync event is rescaled without PASS_MINMAX, clamping MIN to MIN+1, as in vf_stack.
 return {width:base.width,height:base.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:base.pts===null?null:{value:base.pts.value===-(1n<<63n)?-(1n<<63n)+1n:base.pts.value,timeBase:{...base.pts.timeBase}},metadata:{...base.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const maskedclampOperator=defineVideoOperator<MaskedclampStep>({name:'maskedclamp',role:'join',paths:['graph','stream','actor','timed'],examples:['split=3[a][b][c];[a][b][c]maskedclamp','split=3[a][b][c];[b]hflip[d];[c]vflip[e];[a][d][e]maskedclamp=5:10:planes=1','split=3[a][b][c];[a]vflip[d];[c]hflip[e];[d][b][e]maskedclamp=undershoot=255:overshoot=0'],
 parse:pads,formats:()=>maskedclampPixelFormats,geometry:(_step,inputs)=>maskedclampGeometry(inputs),
 combine:(frames,step,options)=>maskedclampVideoFrames(frames,step,options),stateful:()=>true});
