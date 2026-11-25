// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_neighbor.c (deflate, deflate_inflate class). See ../../NOTICE-DEFLATE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoDeflateError extends Error {}
export type DeflateStep={readonly name:'deflate';readonly thresholds:readonly [number,number,number,number]};
/** The pinned vf_neighbor.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * A negotiated format outside the executable table is refused at plan time. */
export const deflatePixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
/** The eight-bit planar members with frame storage here. */
const executable:readonly string[]=Object.freeze(deflatePixelFormats.filter(executableFormat));
const keys=['threshold0','threshold1','threshold2','threshold3'];
/** deflate_inflate class: threshold0..3 only, AV_OPT_TYPE_INT 0..65535 with default 65535; coordinates is not an option here. */
export function parseDeflateOptions(options:string|null):DeflateStep{
 const thresholds:[number,number,number,number]=[65535,65535,65535,65535];
 for(const option of filterOptions(options,keys)){
  const index=keys.indexOf(option.key);
  if(index<0){if(option.key==='enable')throw new VideoFilterParseError('Deflate timeline expressions are not implemented');throw new VideoFilterParseError('Unsupported deflate option');}
  try{thresholds[index]=filterIntegerOption(option.value,{min:0,max:65535,defaultValue:65535});}catch(error){throw new VideoFilterParseError('Invalid deflate threshold: '+(error as Error).message);}
 }
 return Object.freeze({name:'deflate',thresholds:Object.freeze(thresholds)});
}
const checkStep=(step:DeflateStep)=>{if(step?.name!=='deflate'||!Array.isArray(step.thresholds)||step.thresholds.length!==4||step.thresholds.some(value=>!Number.isInteger(value)||value<0||value>65535))throw new VideoDeflateError('Invalid deflate settings');};
/** config_input plane widths: native filter_slice reads one sample past a width-1 row when its threshold is nonzero. */
function deflateLayout(pixelFormat:string,width:number,height:number,step:DeflateStep){
 checkStep(step);const layout=pixelLayout(pixelFormat,width,height);if(!executable.includes(layout.pixelFormat))throw new VideoDeflateError('Deflate pixel format is not supported');
 if(layout.planes.some((plane,index)=>plane.width<2&&step.thresholds[index]!==0))throw new VideoDeflateError('Deflate planes narrower than two samples are not implemented');
 return layout;
}
/** filter_slice with the deflate kernel and its mirrored border tables, into owned tight planes. */
export function deflateVideoFrame(frame:VideoFrameData,step:DeflateStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=deflateLayout(frame.pixelFormat,frame.width,frame.height,step);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoDeflateError('Deflate frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoDeflateError('Invalid deflate plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoDeflateError('Invalid deflate plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoDeflateError('Deflate input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoDeflateError('Invalid deflate timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,threshold=step.thresholds[index]!,{width,height}=plane;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const row=y*stride,target=plane.offset+y*width;
   if(!threshold){data.set(src.subarray(row,row+width),target);continue;}
   const up=y>0?row-stride:row,down=y<height-1?row+stride:row;
   for(let x=0;x<width;x++){
    if((x&16383)===16383)signal?.throwIfAborted();
    // coordinateslb/coordinatesrb mirror the missing column onto x+1 or x-1.
    const left=x>0?x-1:1,right=x<width-1?x+1:width-2,p=src[row+x]!;
    const sum=src[up+left]!+src[up+x]!+src[up+right]!+src[row+left]!+src[row+right]!+src[down+left]!+src[down+x]!+src[down+right]!;
    data[target+x]=Math.max(Math.min(sum>>3,p),p-threshold,0);
   }
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
export const deflateOperator=defineVideoOperator<DeflateStep>({name:'deflate',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['deflate','deflate=threshold0=10,hflip','deflate=1:2:3:4'],
 parse:token=>singlePad(parseDeflateOptions(token.options)),
 formats:()=>deflatePixelFormats,
 geometry:(step,[input])=>{deflateLayout(input!.format,input!.width,input!.height,step);return {width:input!.width,height:input!.height};},
 frame:(frame,step,options)=>deflateVideoFrame(frame,step,options)});
