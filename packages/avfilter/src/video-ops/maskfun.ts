// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_maskfun.c. See ../../NOTICE-MASKFUN.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export type MaskfunStep={readonly name:'maskfun';readonly low:number;readonly high:number;readonly planes:number;readonly fill:number;readonly sum:number};
/** The pinned pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth. A negotiated
 * format outside the executable table is refused at plan time. */
export const maskfunPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit members with frame storage here. */
const executable:readonly string[]=Object.freeze(maskfunPixelFormats.filter(executableFormat));
const keys=['low','high','planes','fill','sum'] as const;
const ranges={low:{min:0,max:65535,defaultValue:10},high:{min:0,max:65535,defaultValue:10},planes:{min:0,max:15,defaultValue:15},fill:{min:0,max:65535,defaultValue:0},sum:{min:0,max:65535,defaultValue:10}} as const;
/** AV_OPT_TYPE_INT options applied in order; native init has no cross-option check. */
export function parseMaskfunOptions(options:string|null):MaskfunStep{
 const values={low:10,high:10,planes:15,fill:0,sum:10};
 for(const option of filterOptions(options,[...keys])){
  if((keys as readonly string[]).includes(option.key)){
   const key=option.key as typeof keys[number];
   try{values[key]=filterIntegerOption(option.value,ranges[key]);}catch(error){throw new VideoFilterParseError(`Invalid maskfun ${key}: ${(error as Error).message}`);}
  }else if(option.key==='enable')throw new VideoFilterParseError('Maskfun timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported maskfun option');
 }
 return Object.freeze({name:'maskfun',...values});
}
/** filter_frame: getsum over the selected planes (checked after each row, sum >= max_sum), then either the empty frame filled with
 * min(fill, max) on every plane, or maskfun8 on the selected planes with the others copied. Owned tight planes. */
export function maskVideoFrame(frame:VideoFrameData,step:MaskfunStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {low,high,planes,fill,sum}=step;
 for(const key of keys){const value=step[key];if(!Number.isInteger(value)||value<ranges[key].min||value>ranges[key].max)throw new Error('Invalid maskfun settings');}
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);if(!executable.includes(layout.pixelFormat))throw new Error('Maskfun pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new Error('Maskfun frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Invalid maskfun plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid maskfun plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new Error('Maskfun input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid maskfun timestamp time base');
 // Every supported layout has depth 8: max is 255 and the empty frame holds min(fill, 255).
 const max=255,data=new Uint8Array(layout.bytes),active=(index:number)=>(planes>>index&1)===1;
 // set_max_sum in uint64; rows are summed as safe integers and accumulated in bigint.
 let limit=0n;for(const [index,plane]of layout.planes.entries())if(active(index))limit+=BigInt(sum)*BigInt(plane.rowBytes)*BigInt(plane.height);
 let total=0n,empty=false;
 scan:for(const [index,plane]of layout.planes.entries()){
  if(!active(index))continue;const input=frame.planes[index]!,stride=frame.linesizes[index]!;
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();let row=0;const start=y*stride;
   for(let x=0;x<plane.rowBytes;x++)row+=input[start+x]!;
   total+=BigInt(row);if(total>=limit){empty=true;break scan;}
  }
 }
 if(empty)data.fill(Math.min(fill,max));
 else for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!,on=active(index);
  for(let y=0;y<plane.height;y++){
   signal?.throwIfAborted();const sourceRow=y*stride,targetRow=plane.offset+y*plane.rowBytes;
   if(!on){data.set(input.subarray(sourceRow,sourceRow+plane.rowBytes),targetRow);continue;}
   for(let x=0;x<plane.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();const value=input[sourceRow+x]!;data[targetRow+x]=value<=low?0:value>high?max:value;}
  }
 }
 // The empty frame comes from the input link, so it shares the input's aspect ratio and colour properties.
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const maskfunOperator=defineVideoOperator<MaskfunStep>({name:'maskfun',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['maskfun','maskfun=low=100:high=50:sum=255','maskfun=fill=77:sum=0,hflip','maskfun=0:255:1:9:300'],
 parse:(token:FilterToken)=>singlePad(parseMaskfunOptions(token.options)),
 formats:()=>maskfunPixelFormats,
 frame:(frame,step,options)=>maskVideoFrame(frame,step,options)});
