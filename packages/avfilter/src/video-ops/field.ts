// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_field.c. See ../../NOTICE-FIELD.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export class VideoFieldError extends Error {}
/** type: 0 top (even rows), 1 bottom (odd rows). */
export type FieldStep={readonly name:'field';readonly type:0|1};
const types:Readonly<Record<string,0|1>>={top:0,bottom:1,'0':0,'1':1};
/** config_props_output: (h + top) / 2 rows. Native strides the input by two rows, so refuse the
 * cases where it would emit an empty link or read one plane row past the input. */
export function fieldHeight(pixelFormat:string,width:number,height:number,type:0|1):number{
 const output=(height+(type===0?1:0))>>1;
 if(!negotiationOrder.includes(pixelFormat as typeof negotiationOrder[number]))throw new VideoFieldError('Field pixel format is not supported');
 if(output<1)throw new VideoFieldError('Field bottom of a one-row input gives an empty frame');
 const source=pixelLayout(pixelFormat,width,height).planes,target=pixelLayout(pixelFormat,width,output).planes;
 for(const [index,plane]of target.entries())if(2*(plane.height-1)+type>=source[index]!.height)throw new VideoFieldError('Field bottom reads past the subsampled chroma plane for this height');
 return output;
}
/** filter_frame: every second row of each plane, from row 1 for bottom, as owned tight planes. */
export function fieldVideoFrame(frame:VideoFrameData,type:0|1,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 if(type!==0&&type!==1)throw new VideoFieldError('Invalid field type');
 const height=fieldHeight(frame.pixelFormat,frame.width,frame.height,type),input=pixelLayout(frame.pixelFormat,frame.width,frame.height),layout=pixelLayout(frame.pixelFormat,frame.width,height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoFieldError('Field frame exceeds allocation limit');
 if(frame.planes.length!==input.planes.length||frame.linesizes.length!==input.planes.length)throw new VideoFieldError('Invalid field plane count');
 let resident=0n;
 for(const [index,plane]of input.planes.entries()){
  const data=frame.planes[index],stride=frame.linesizes[index];
  if(!(data instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(data.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoFieldError('Invalid field plane stride or storage');
  resident+=BigInt(data.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoFieldError('Field input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoFieldError('Invalid field timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const source=frame.planes[index]!,stride=frame.linesizes[index]!;
  for(let y=0;y<plane.height;y++){signal?.throwIfAborted();const row=(2*y+type)*stride;data.set(source.subarray(row,row+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 }
 return {width:frame.width,height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** No query_formats upstream: every table format. The sample aspect ratio is unchanged. */
export const fieldOperator=defineVideoOperator<FieldStep>({name:'field',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['field','field=bottom','field=type=1,hflip','scale=8:10,field=top'],
 parse(token){
  let type:0|1=0;
  for(const option of filterOptions(token.options,['type'])){
   if(option.key!=='type')throw new VideoFilterParseError(option.key==='enable'?'Field timeline expressions are not implemented':'Unsupported field option');
   if(!Object.hasOwn(types,option.value))throw new VideoFilterParseError('Only field types top, bottom, 0 and 1 are implemented');
   type=types[option.value]!;
  }
  return singlePad(Object.freeze({name:'field',type}));
 },
 geometry:(step,[input])=>({width:input!.width,height:fieldHeight(input!.format,input!.width,input!.height,step.type)}),
 frame:(frame,step,options)=>fieldVideoFrame(frame,step.type,options)});
