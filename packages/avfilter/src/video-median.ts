// SPDX-License-Identifier: LGPL-2.1-or-later
// Options, radius clipping, the percentile threshold and the eight-bit column-histogram median adapted from pinned FFmpeg
// libavfilter/vf_median.c and libavfilter/median_template.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE-MEDIAN.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
import {filterIntegerOption} from './activation/integer-option.js';
import {VideoFilterParseError} from './video-ops/descriptor.js';
import type {VideoFrameOptions} from './video-ops/descriptor.js';
export class VideoMedianError extends Error {}
/** `percentile` is the float32 option value; `radiusV` 0 means `radius`. */
export interface VideoMedianSettings {readonly radius:number;readonly planes:number;readonly radiusV:number;readonly percentile:number}
/** The eight-bit pinned pix_fmts with frame storage here. */
export const medianStorageFormats:readonly string[]=Object.freeze(['yuv444p','yuv422p','yuva420p','yuv420p','gbrp','gray']);
const keys=['radius','planes','radiusV','percentile'] as const,ranges={radius:[1,127,1],planes:[0,15,15],radiusV:[0,127,0]} as const;
/** AV_OPT_TYPE_INT expressions for radius, planes and radiusV; AV_OPT_TYPE_FLOAT percentile as a decimal, range-checked as a double, stored as float. */
export function parseMedianOptions(options:string|null):VideoMedianSettings{
 const values={radius:1,planes:15,radiusV:0,percentile:Math.fround(0.5)};
 for(const option of filterOptions(options,keys)){
  if(option.key==='enable')throw new VideoFilterParseError('Median timeline expressions are not implemented');
  if(option.key==='percentile'){
   if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(option.value))throw new VideoFilterParseError('Only decimal median percentile values are implemented');
   const value=Number(option.value);if(!(value>=0&&value<=1))throw new VideoFilterParseError('Invalid median percentile');values.percentile=Math.fround(value);continue;
  }
  if(option.key!=='radius'&&option.key!=='planes'&&option.key!=='radiusV')throw new VideoFilterParseError('Unsupported median option');
  const [min,max,defaultValue]=ranges[option.key];try{values[option.key]=filterIntegerOption(option.value,{min,max,defaultValue});}catch{throw new VideoFilterParseError(`Invalid median ${option.key}`);}
 }
 return Object.freeze(values);
}
export interface MedianPlan {readonly layout:ReturnType<typeof pixelLayout>;readonly radius:number;readonly radiusV:number;readonly threshold:number;readonly filtered:readonly boolean[]}
/** config_input and check_params: radiusV 0 takes radius, then both clip to every filtered plane, and t truncates the float product. */
export function medianPlan(pixelFormat:string,width:number,height:number,settings:VideoMedianSettings):MedianPlan{
 const {radius:r0,planes,radiusV:v0,percentile}=settings;
 if(!Number.isInteger(r0)||r0<1||r0>127||!Number.isInteger(planes)||planes<0||planes>15||!Number.isInteger(v0)||v0<0||v0>127||typeof percentile!=='number'||!(percentile>=0&&percentile<=1)||Math.fround(percentile)!==percentile)throw new VideoMedianError('Invalid median settings');
 const layout=pixelLayout(pixelFormat,width,height);if(!medianStorageFormats.includes(layout.pixelFormat))throw new VideoMedianError('Median pixel format is not supported');
 let radius=r0,radiusV=v0||r0;const filtered=layout.planes.map((_,index)=>(planes>>index&1)===1);
 for(const [index,plane]of layout.planes.entries()){if(!filtered[index])continue;if(plane.width<radius*2+1)radius=plane.width-1>>1;if(plane.height<radiusV*2+1)radiusV=plane.height-1>>1;}
 // The htype (uint16) luc column cursors reach width+radius; wider planes would wrap them.
 if(layout.planes.some((plane,index)=>filtered[index]&&plane.width+radius+1>65535))throw new VideoMedianError('Median planes wider than 65534 samples minus the radius are not implemented');
 const threshold=Math.trunc(Math.fround(Math.fround((2*radius*radiusV+radiusV+radius)*2)*percentile));
 return {layout,radius,radiusV,threshold,filtered:Object.freeze(filtered)};
}
const BINS=16;
/** filter_plane for DEPTH 8 as one job: column fine/coarse histograms over the clamped rows, a row-wise coarse sum and lazily
 * refreshed fine segments, picking the first value whose running count exceeds t. */
function filterPlane(src:Uint8Array,stride:number,dst:Uint8Array,offset:number,w:number,h:number,r:number,rv:number,t:number,signal?:AbortSignal):void{
 const cfine=new Uint16Array(BINS*BINS*w),ccoarse=new Uint16Array(BINS*w),coarse=new Uint16Array(BINS),fine=new Uint16Array(BINS*BINS),luc=new Uint16Array(BINS);
 const add=(row:number,n:number)=>{for(let j=0;j<w;j++){const v=src[row+j]!,f=BINS*(w*(v>>4)+j)+(v&15),c=BINS*j+(v>>4);cfine[f]=cfine[f]!+n;ccoarse[c]=ccoarse[c]!+n;}};
 add(0,rv+1);for(let i=0;i<rv;i++)add(i*stride,1);
 const hadd=(d:Uint16Array,o:number,s:Uint16Array,p:number,f=1)=>{for(let b=0;b<BINS;b++)d[o+b]=d[o+b]!+f*s[p+b]!;},hsub=(d:Uint16Array,o:number,s:Uint16Array,p:number)=>{for(let b=0;b<BINS;b++)d[o+b]=d[o+b]!-s[p+b]!;};
 for(let i=0;i<h;i++){
  signal?.throwIfAborted();coarse.fill(0);fine.fill(0);luc.fill(0);
  add(Math.max(0,i-rv-1)*stride,-1);add(Math.min(h-1,i+rv)*stride,1);
  hadd(coarse,0,ccoarse,0,r);for(let j=0;j<r;j++)hadd(coarse,0,ccoarse,BINS*j);
  for(let k=0;k<BINS;k++)hadd(fine,BINS*k,cfine,BINS*w*k,2*r+1);
  const target=offset+i*w;
  for(let j=0;j<w;j++){
   if((j&4095)===0&&j)signal?.throwIfAborted();
   hadd(coarse,0,ccoarse,BINS*Math.min(j+r,w-1));
   let sum=0,k=0;for(;k<BINS;k++){sum+=coarse[k]!;if(sum>t){sum-=coarse[k]!;break;}}
   if(k>=BINS)throw new VideoMedianError('Median coarse histogram search failed');
   const segment=BINS*k,column=(c:number)=>BINS*(w*k+c);
   if(luc[k]!<=j-r){
    fine.fill(0,segment,segment+BINS);
    for(luc[k]=j-r;luc[k]!<Math.min(j+r+1,w);luc[k]=luc[k]!+1)hadd(fine,segment,cfine,column(luc[k]!));
    if(luc[k]!<j+r+1){hadd(fine,segment,cfine,column(w-1),j+r+1-w);luc[k]=j+r+1;}
   }else for(;luc[k]!<j+r+1;luc[k]=luc[k]!+1){hsub(fine,segment,cfine,column(Math.max(luc[k]!-2*r-1,0)));hadd(fine,segment,cfine,column(Math.min(luc[k]!,w-1)));}
   hsub(coarse,0,ccoarse,BINS*Math.max(j-r,0));
   let b=0;for(;b<BINS;b++){sum+=fine[segment+b]!;if(sum>t){dst[target+j]=BINS*k+b;break;}}
   if(b>=BINS)throw new VideoMedianError('Median fine histogram search failed');
  }
 }
}
/** filter_frame: selected planes are filtered, the others copied, into owned tight planes; the input frame is never written. */
export function medianVideoFrame(frame:VideoFrameData,settings:VideoMedianSettings,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const plan=medianPlan(frame.pixelFormat,frame.width,frame.height,settings),layout=plan.layout;
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoMedianError('Median frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoMedianError('Invalid median plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoMedianError('Invalid median plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoMedianError('Median input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoMedianError('Invalid median timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!;
  if(plan.filtered[index]){filterPlane(src,stride,data,plane.offset,plane.width,plane.height,plan.radius,plan.radiusV,plan.threshold,signal);continue;}
  for(let y=0;y<plane.height;y++){if((y&255)===0)signal?.throwIfAborted();data.set(src.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 }
 signal?.throwIfAborted();
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
