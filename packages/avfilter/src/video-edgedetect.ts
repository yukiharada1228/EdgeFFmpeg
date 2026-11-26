// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_edgedetect.c, edge_common.c and edge_template.c. See ../NOTICE-EDGEDETECT.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
export class VideoEdgedetectError extends Error {}
export type EdgedetectMode='wires'|'colormix'|'canny';
export type EdgedetectStep={readonly name:'edgedetect';readonly high:number;readonly low:number;readonly highU8:number;readonly lowU8:number;readonly mode:EdgedetectMode;readonly planes:number};
export const edgedetectModes:readonly EdgedetectMode[]=Object.freeze(['wires','colormix','canny']);
/** query_formats lists in declared order, per mode. */
export const edgedetectPixelFormats:Readonly<Record<EdgedetectMode,readonly string[]>>=Object.freeze({wires:Object.freeze(['gray']),colormix:Object.freeze(['gbrp','gray']),canny:Object.freeze(['yuv420p','yuv422p','yuv444p','gbrp','gray'])});
const checkStep=(step:EdgedetectStep)=>{if(step?.name!=='edgedetect'||!edgedetectModes.includes(step.mode)||!Number.isInteger(step.planes)||[step.highU8,step.lowU8].some(value=>!Number.isInteger(value)||value<0||value>255))throw new VideoEdgedetectError('Invalid edgedetect settings');};
export function edgedetectLayout(pixelFormat:string,width:number,height:number,step:EdgedetectStep){
 checkStep(step);if(!edgedetectPixelFormats[step.mode].includes(pixelFormat))throw new VideoEdgedetectError('Edgedetect pixel format is not supported');
 return pixelLayout(pixelFormat,width,height);
}
/** get_rounded_direction: 0 45UP, 1 45DOWN, 2 HORIZONTAL, 3 VERTICAL. */
function direction(gx:number,gy:number):number{
 if(gx){
  if(gx<0){gx=-gx;gy=-gy;}
  gy*=65536;const tanpi8gx=27146*gx,tan3pi8gx=158218*gx;
  if(gy>-tan3pi8gx&&gy<-tanpi8gx)return 0;
  if(gy>-tanpi8gx&&gy<tanpi8gx)return 2;
  if(gy>tanpi8gx&&gy<tan3pi8gx)return 1;
 }
 return 3;
}
/** One plane of filter_frame: ff_gaussian_blur_8, ff_sobel_8, ff_non_maximum_suppression, ff_double_threshold and color_mix. */
function edgePlane(src:Uint8Array,stride:number,w:number,h:number,low:number,high:number,colormix:boolean,dst:Uint8Array,signal:AbortSignal|undefined){
 const blur=new Uint8Array(w*h),gradients=new Uint16Array(w*h),directions=new Uint8Array(w*h),nms=new Uint8Array(w*h);
 // Rows and columns outside [2, n-2) are copied, as the FFMIN(n,2) heads and n-2 tails do.
 for(let j=0;j<h;j++){
  signal?.throwIfAborted();const s=j*stride,d=j*w;
  if(j<2||j>=h-2){blur.set(src.subarray(s,s+w),d);continue;}
  for(let i=0;i<w;i++){
   if(i<2||i>=w-2){blur[d+i]=src[s+i]!;continue;}
   const a=s-2*stride+i,b=s-stride+i,c=s+i,e=s+stride+i,f=s+2*stride+i;
   blur[d+i]=Math.trunc(((src[a-2]!+src[f-2]!)*2+(src[a-1]!+src[f-1]!)*4+(src[a]!+src[f]!)*5+(src[a+1]!+src[f+1]!)*4+(src[a+2]!+src[f+2]!)*2
    +(src[b-2]!+src[e-2]!)*4+(src[b-1]!+src[e-1]!)*9+(src[b]!+src[e]!)*12+(src[b+1]!+src[e+1]!)*9+(src[b+2]!+src[e+2]!)*4
    +src[c-2]!*5+src[c-1]!*12+src[c]!*15+src[c+1]!*12+src[c+2]!*5)/159);
  }
 }
 // Interior gradients only; native's calloc'd border gradients stay zero and border directions are never read.
 for(let j=1;j<h-1;j++){
  signal?.throwIfAborted();
  for(let i=1;i<w-1;i++){
   const u=(j-1)*w+i,m=j*w+i,v=(j+1)*w+i;
   const gx=-blur[u-1]!+blur[u+1]!-2*blur[m-1]!+2*blur[m+1]!-blur[v-1]!+blur[v+1]!;
   const gy=-blur[u-1]!+blur[v-1]!-2*blur[u]!+2*blur[v]!-blur[u+1]!+blur[v+1]!;
   gradients[m]=Math.abs(gx)+Math.abs(gy);directions[m]=direction(gx,gy);
  }
 }
 for(let j=1;j<h-1;j++){
  signal?.throwIfAborted();
  for(let i=1;i<w-1;i++){
   const m=j*w+i,g=gradients[m]!;let a:number,b:number;
   switch(directions[m]){case 0:a=m+w-1;b=m-w+1;break;case 1:a=m-w-1;b=m+w+1;break;case 2:a=m-1;b=m+1;break;default:a=m-w;b=m+w;}
   if(g>gradients[a]!&&g>gradients[b]!)nms[m]=Math.min(g,255);
  }
 }
 for(let j=0;j<h;j++){
  signal?.throwIfAborted();const row=j*w;
  for(let i=0;i<w;i++){
   const m=row+i,p=nms[m]!;let out=0;
   if(p>high)out=p;
   else if(i&&i!==w-1&&j&&j!==h-1&&p>low&&(nms[m-w-1]!>high||nms[m-w]!>high||nms[m-w+1]!>high||nms[m-1]!>high||nms[m+1]!>high||nms[m+w-1]!>high||nms[m+w]!>high||nms[m+w+1]!>high))out=p;
   dst[m]=colormix?(out+src[j*stride+i]!)>>1:out;
  }
 }
}
/** filter_frame into owned tight planes: unselected planes are copied (direct mode leaves them untouched). */
export function edgedetectVideoFrame(frame:VideoFrameData,step:EdgedetectStep,options:{readonly maxFrameBytes:number;readonly signal?:AbortSignal}):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=edgedetectLayout(frame.pixelFormat,frame.width,frame.height,step);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoEdgedetectError('Edgedetect frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoEdgedetectError('Invalid edgedetect plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoEdgedetectError('Invalid edgedetect plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoEdgedetectError('Edgedetect input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoEdgedetectError('Invalid edgedetect timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,target=data.subarray(plane.offset,plane.offset+plane.bytes),{width,height}=plane;
  if(!((1<<index)&step.planes)){for(let y=0;y<height;y++){signal?.throwIfAborted();target.set(src.subarray(y*stride,y*stride+width),y*width);}continue;}
  edgePlane(src,stride,width,height,step.lowU8,step.highU8,step.mode==='colormix',target,signal);
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
