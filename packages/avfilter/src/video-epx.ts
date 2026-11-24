// SPDX-License-Identifier: LGPL-2.1-or-later
// Neighbour rules, edge clamping, scale option and pixel formats adapted from pinned FFmpeg
// libavfilter/vf_epx.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE-EPX.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
export class VideoEpxError extends Error {}
export interface VideoEpxSettings {readonly n:2|3}
export interface VideoEpxOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** Pinned pix_fmts: packed 32-bit RGB with alpha; pixels are compared as whole 32-bit words. */
export const epxPixelFormats:readonly string[]=Object.freeze(['rgba','bgra','argb','abgr']);
/** AV_OPT_TYPE_INT n in [2,3], default 3; only plain decimal values are implemented. epx has no timeline. */
export function parseEpxOptions(options:string|null):VideoEpxSettings{
 let n:2|3=3;
 for(const option of filterOptions(options,['n'])){
  if(option.key==='n'){if(!/^[+]?0*[0-9]+$/.test(option.value))throw new VideoEpxError('Only decimal integer epx scale factors are implemented');const value=Number(option.value);if(value!==2&&value!==3)throw new VideoEpxError('epx scale factor n must be 2 or 3');n=value;}
  else if(option.key==='enable')throw new VideoEpxError('epx does not support timeline expressions');
  else throw new VideoEpxError('Unsupported epx option');
 }
 return Object.freeze({n});
}
/** config_output: w*n by h*n; sizes above the av_image_check_size bound are refused. */
export function epxGeometry(pixelFormat:string,width:number,height:number,settings:VideoEpxSettings):{readonly width:number;readonly height:number}{
 const format=pixelLayout(pixelFormat,width,height).pixelFormat;if(!epxPixelFormats.includes(format))throw new VideoEpxError('epx pixel format is not supported');
 const {n}=settings;if(n!==2&&n!==3)throw new VideoEpxError('Invalid epx settings');
 const w=width*n,h=height*n;if((w+128)*(h+128)>=Math.floor(2147483647/8))throw new VideoEpxError('epx output size is invalid');
 return Object.freeze({width:w,height:h});
}
/** epx2_slice/epx3_slice over the whole frame into owned tight planes; output bytes are bounded by maxFrameBytes. */
export function epxVideoFrame(frame:VideoFrameData,settings:VideoEpxSettings,options:VideoEpxOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {width,height}=frame,size=epxGeometry(frame.pixelFormat,width,height,settings),n=settings.n,layout=pixelLayout(frame.pixelFormat,size.width,size.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoEpxError('epx frame exceeds allocation limit');
 const input=frame.planes[0],stride=frame.linesizes[0],rowBytes=width*4;
 if(frame.planes.length!==1||frame.linesizes.length!==1)throw new VideoEpxError('Invalid epx plane count');
 if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(height-1)+BigInt(rowBytes))throw new VideoEpxError('Invalid epx plane stride or storage');
 if(input.length>maxFrameBytes)throw new VideoEpxError('epx input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoEpxError('Invalid epx timestamp time base');
 // Tight 32-bit words: equality is byte-order independent and writing a word back restores its bytes.
 const src=new Uint32Array(width*height),srcBytes=new Uint8Array(src.buffer);
 for(let y=0;y<height;y++){signal?.throwIfAborted();srcBytes.set(input.subarray(y*stride!,y*stride!+rowBytes),y*rowBytes);}
 const outWidth=size.width,dst=new Uint32Array(outWidth*size.height),last=width-1;
 for(let y=0;y<height;y++){
  signal?.throwIfAborted();const top=Math.max(y-1,0)*width,mid=y*width,bottom=Math.min(y+1,height-1)*width,row=y*n*outWidth;
  for(let x=0;x<width;x++){
   if((x&4095)===0)signal?.throwIfAborted();const l=Math.max(x-1,0),r=Math.min(x+1,last);
   const B=src[top+x]!,D=src[mid+l]!,E=src[mid+x]!,F=src[mid+r]!,H=src[bottom+x]!,blend=B!==H&&D!==F;
   if(n===2){
    const o=row+x*2;
    dst[o]=blend&&D===B?D:E;dst[o+1]=blend&&B===F?F:E;dst[o+outWidth]=blend&&D===H?D:E;dst[o+outWidth+1]=blend&&H===F?F:E;
   }else{
    const o=row+x*3,o1=o+outWidth,o2=o1+outWidth;
    if(!blend){dst.fill(E,o,o+3);dst.fill(E,o1,o1+3);dst.fill(E,o2,o2+3);continue;}
    const A=src[top+l]!,C=src[top+r]!,G=src[bottom+l]!,I=src[bottom+r]!;
    dst[o]=D===B?D:E;dst[o+1]=D===B&&E!==C||B===F&&E!==A?B:E;dst[o+2]=B===F?F:E;
    dst[o1]=D===B&&E!==G||D===H&&E!==A?D:E;dst[o1+1]=E;dst[o1+2]=B===F&&E!==I||H===F&&E!==C?F:E;
    dst[o2]=D===H?D:E;dst[o2+1]=D===H&&E!==I||H===F&&E!==G?H:E;dst[o2+2]=H===F?F:E;
   }
  }
 }
 const data=new Uint8Array(dst.buffer);
 return {width:size.width,height:size.height,pixelFormat:layout.pixelFormat,planes:[data],linesizes:[layout.planes[0]!.rowBytes],pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
