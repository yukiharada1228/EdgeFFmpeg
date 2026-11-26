// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_chromashift.c (rgbashift only). See ../../NOTICE-RGBASHIFT.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
export class VideoRgbashiftError extends Error {}
export type RgbashiftStep={readonly name:'rgbashift';readonly rh:number;readonly rv:number;readonly gh:number;readonly gv:number;readonly bh:number;readonly bv:number;readonly ah:number;readonly av:number;readonly edge:0|1};
/** Native rgb_pix_fmts in declared order (native-endian names). Only gbrp has frame storage here: the shared negotiators refuse every
 * other pick (gbrap from packed RGB with alpha) by name at plan time. */
const formats=Object.freeze('gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le'.split(' '));
const shifts=['rh','rv','gh','gv','bh','bv','ah','av'] as const;
function validate(pixelFormat:string):void{if(pixelFormat!=='gbrp')throw new VideoRgbashiftError('Rgbashift pixel format is not supported');}
function rgbashiftFrame(frame:VideoFrameData,step:RgbashiftStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {rh,rv,gh,gv,bh,bv,ah,av,edge}=step;if(![rh,rv,gh,gv,bh,bv,ah,av].every(shift=>Number.isInteger(shift)&&shift>=-255&&shift<=255)||edge!==0&&edge!==1)throw new VideoRgbashiftError('Invalid rgbashift settings');
 validate(frame.pixelFormat);const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoRgbashiftError('Rgbashift frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoRgbashiftError('Invalid rgbashift plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoRgbashiftError('Invalid rgbashift plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoRgbashiftError('Rgbashift input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoRgbashiftError('Invalid rgbashift timestamp time base');
 // rgbasmear_slice8 clamps both indices; rgbawrap_slice8 uses C % with the negative fix-up. Every plane uses width[1] and height[1],
 // which equal the frame size for gbrp. Planes are G, B, R; gbrp has no alpha plane, so ah and av have no effect (nb_planes < 4).
 const data=new Uint8Array(layout.bytes),w=layout.planes[1]!.width,h=layout.planes[1]!.height,index=(value:number,size:number)=>{if(edge===0)return value<0?0:value>size-1?size-1:value;const r=value%size;return r<0?r+size:r;};
 for(const [plane,horizontal,vertical]of [[0,gh,gv],[1,bh,bv],[2,rh,rv]] as const){
  const input=frame.planes[plane]!,stride=frame.linesizes[plane]!,offset=layout.planes[plane]!.offset,columns=Int32Array.from({length:w},(_,x)=>index(x-horizontal,w));
  for(let y=0;y<h;y++){
   signal?.throwIfAborted();const row=index(y-vertical,h)*stride,target=offset+y*w;
   for(let x=0;x<w;x++)data[target+x]=input[row+columns[x]!]!;
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** AV_OPT_TYPE_INT values are restricted to decimal integers; native expressions are refused explicitly. */
export function parseRgbashiftOptions(options:string|null):RgbashiftStep{
 const values={rh:0,rv:0,gh:0,gv:0,bh:0,bv:0,ah:0,av:0,edge:0 as 0|1};
 for(const option of filterOptions(options,[...shifts,'edge'])){
  if(option.key==='edge'){
   const value=option.value==='smear'?0:option.value==='wrap'?1:/^[+-]?\d+$/.test(option.value)?Number(option.value):NaN;
   if(value!==0&&value!==1)throw new VideoFilterParseError('Only rgbashift edge smear, wrap, 0 and 1 are implemented');values.edge=value;
  }else if((shifts as readonly string[]).includes(option.key)){
   const value=/^[+-]?\d+$/.test(option.value)?Number(option.value):NaN;
   if(!Number.isInteger(value)||value< -255||value>255)throw new VideoFilterParseError(`Only decimal rgbashift ${option.key} integers from -255 to 255 are implemented`);values[option.key as typeof shifts[number]]=value===0?0:value;
  }else if(option.key==='enable')throw new VideoFilterParseError('Rgbashift timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported rgbashift option');
 }
 return Object.freeze({name:'rgbashift',...values});
}
export const rgbashiftOperator=defineVideoOperator<RgbashiftStep>({name:'rgbashift',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['rgbashift','format=gbrp,rgbashift=rh=1:gv=-2,hflip','format=gbrp,rgbashift=3:-1:2:1:-2:2:5:5:wrap','format=gbrp,rgbashift=bv=255:rh=-255:gh=9:edge=wrap,vflip'],
 parse:token=>singlePad(parseRgbashiftOptions(token.options)),
 formats:()=>formats,validate:pixelFormat=>validate(pixelFormat),
 frame:(frame,step,options)=>rgbashiftFrame(frame,step,options)});
