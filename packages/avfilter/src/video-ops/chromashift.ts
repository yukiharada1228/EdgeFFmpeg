// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_chromashift.c (chromashift only). See ../../NOTICE-CHROMASHIFT.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export class VideoChromashiftError extends Error {}
export type ChromashiftStep={readonly name:'chromashift';readonly cbh:number;readonly cbv:number;readonly crh:number;readonly crv:number;readonly edge:0|1};
/** Native yuv_pix_fmts intersected with the negotiation table, in table order; yuva420p is negotiated and then refused by validate. */
const formats=Object.freeze(negotiationOrder.filter(format=>['yuva420p','yuv444p','yuv422p','yuv420p'].includes(format)));
const processed:readonly string[]=Object.freeze(['yuv420p','yuv422p','yuv444p']),shifts=['cbh','cbv','crh','crv'] as const;
/** Native never writes the yuva420p alpha plane, so its output would depend on buffer-pool history. */
function validate(pixelFormat:string):void{
 if(pixelFormat==='yuva420p')throw new VideoChromashiftError('Chromashift yuva420p is not implemented: native output leaves the alpha plane unwritten');
 if(!processed.includes(pixelFormat))throw new VideoChromashiftError('Chromashift pixel format is not supported');
}
function chromashiftFrame(frame:VideoFrameData,step:ChromashiftStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {cbh,cbv,crh,crv,edge}=step;if(![cbh,cbv,crh,crv].every(shift=>Number.isInteger(shift)&&shift>=-255&&shift<=255)||edge!==0&&edge!==1)throw new VideoChromashiftError('Invalid chromashift settings');
 validate(frame.pixelFormat);const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoChromashiftError('Chromashift frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoChromashiftError('Invalid chromashift plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoChromashiftError('Invalid chromashift plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoChromashiftError('Chromashift input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoChromashiftError('Invalid chromashift timestamp time base');
 const data=new Uint8Array(layout.bytes),luma=layout.planes[0]!,source=frame.planes[0]!,lumaStride=frame.linesizes[0]!;
 // av_image_copy_plane of luma.
 for(let y=0;y<luma.height;y++){signal?.throwIfAborted();data.set(source.subarray(y*lumaStride,y*lumaStride+luma.rowBytes),luma.offset+y*luma.rowBytes);}
 // smear_slice8 clamps both indices; wrap_slice8 uses C % with the negative fix-up. Both chroma planes share width[1] and height[1].
 const w=layout.planes[1]!.width,h=layout.planes[1]!.height,index=(value:number,size:number)=>{if(edge===0)return value<0?0:value>size-1?size-1:value;const r=value%size;return r<0?r+size:r;};
 for(const [plane,horizontal,vertical]of [[1,cbh,cbv],[2,crh,crv]] as const){
  const input=frame.planes[plane]!,stride=frame.linesizes[plane]!,offset=layout.planes[plane]!.offset,columns=Int32Array.from({length:w},(_,x)=>index(x-horizontal,w));
  for(let y=0;y<h;y++){
   signal?.throwIfAborted();const row=index(y-vertical,h)*stride,target=offset+y*w;
   for(let x=0;x<w;x++)data[target+x]=input[row+columns[x]!]!;
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** AV_OPT_TYPE_INT values are restricted to decimal integers; native expressions are refused explicitly. */
export function parseChromashiftOptions(options:string|null):ChromashiftStep{
 const values={cbh:0,cbv:0,crh:0,crv:0,edge:0 as 0|1};
 for(const option of filterOptions(options,['cbh','cbv','crh','crv','edge'])){
  if(option.key==='edge'){
   const value=option.value==='smear'?0:option.value==='wrap'?1:/^[+-]?\d+$/.test(option.value)?Number(option.value):NaN;
   if(value!==0&&value!==1)throw new VideoFilterParseError('Only chromashift edge smear, wrap, 0 and 1 are implemented');values.edge=value;
  }else if((shifts as readonly string[]).includes(option.key)){
   const value=/^[+-]?\d+$/.test(option.value)?Number(option.value):NaN;
   if(!Number.isInteger(value)||value< -255||value>255)throw new VideoFilterParseError(`Only decimal chromashift ${option.key} integers from -255 to 255 are implemented`);values[option.key as typeof shifts[number]]=value===0?0:value;
  }else if(option.key==='enable')throw new VideoFilterParseError('Chromashift timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported chromashift option');
 }
 return Object.freeze({name:'chromashift',...values});
}
export const chromashiftOperator=defineVideoOperator<ChromashiftStep>({name:'chromashift',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['chromashift','chromashift=cbh=1:crv=-2,hflip','format=yuv444p,chromashift=3:-1:2:1:wrap','chromashift=cbv=255:crh=-255:edge=wrap,vflip'],
 parse:token=>singlePad(parseChromashiftOptions(token.options)),
 formats:()=>formats,validate:pixelFormat=>validate(pixelFormat),
 frame:(frame,step,options)=>chromashiftFrame(frame,step,options)});
