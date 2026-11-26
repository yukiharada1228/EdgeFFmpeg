// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_gradfun.c. See ../../NOTICE-GRADFUN.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
export class VideoGradfunError extends Error {}
/** `strength` is the float32 option value, `radius` the init() value ((radius+1)&~1 clipped to [4,32]), `thresh` (int)((1<<15)/strength). */
export type GradfunStep={readonly name:'gradfun';readonly strength:number;readonly radius:number;readonly thresh:number};
/** The pinned vf_gradfun.c pix_fmts in declared order. A negotiated format outside the executable table is refused at plan time. */
export const gradfunPixelFormats:readonly string[]=Object.freeze(['yuv410p','yuv420p','gray','yuv444p','yuv422p','yuv411p','yuv440p','gbrp']);
/** The members with frame storage here; [log2_chroma_w, log2_chroma_h]. */
const chroma:Readonly<Record<string,readonly [number,number]>>={yuv420p:[1,1],gray:[0,0],yuv444p:[0,0],yuv422p:[1,0],gbrp:[0,0]};
/** The 8x8 ordered dither table of vf_gradfun.c. */
const dither=[[0x00,0x60,0x18,0x78,0x06,0x66,0x1E,0x7E],[0x40,0x20,0x58,0x38,0x46,0x26,0x5E,0x3E],[0x10,0x70,0x08,0x68,0x16,0x76,0x0E,0x6E],[0x50,0x30,0x48,0x28,0x56,0x36,0x4E,0x2E],[0x04,0x64,0x1C,0x7C,0x02,0x62,0x1A,0x7A],[0x44,0x24,0x5C,0x3C,0x42,0x22,0x5A,0x3A],[0x14,0x74,0x0C,0x6C,0x12,0x72,0x0A,0x6A],[0x54,0x34,0x4C,0x2C,0x52,0x32,0x4A,0x2A]].map(row=>Uint16Array.from(row));
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const thresholdOf=(strength:number)=>Math.trunc(Math.fround(32768/strength));
/** AV_OPT_TYPE_FLOAT strength: the double is range-checked against [0.51,64] before write_number stores it as float. */
function strengthValue(value:string):number{
 if(!decimal.test(value))throw new VideoFilterParseError('Only constant decimal gradfun strength values are implemented');
 const n=Number(value);if(!(n>=0.51&&n<=64))throw new VideoFilterParseError(`Gradfun strength ${value} is outside [0.51 - 64]`);return Math.fround(n);
}
export function parseGradfunOptions(options:string|null):GradfunStep{
 let strength=Math.fround(1.2),radius=16;
 for(const option of filterOptions(options,['strength','radius'])){
  switch(option.key){
   case 'strength':strength=strengthValue(option.value);break;
   case 'radius':try{radius=filterIntegerOption(option.value,{min:4,max:32,defaultValue:16});}catch(error){throw new VideoFilterParseError('Invalid gradfun radius: '+(error as Error).message);}break;
   case 'enable':throw new VideoFilterParseError('Gradfun timeline expressions are not implemented');
   default:throw new VideoFilterParseError('Unsupported gradfun option');
  }
 }
 return Object.freeze({name:'gradfun',strength,radius:Math.min(32,Math.max(4,(radius+1)&~1)),thresh:thresholdOf(strength)});
}
const checkStep=(step:GradfunStep)=>{if(step?.name!=='gradfun'||typeof step.strength!=='number'||!(step.strength>=Math.fround(0.51)&&step.strength<=64)||Math.fround(step.strength)!==step.strength||!Number.isInteger(step.radius)||step.radius<4||step.radius>32||step.radius%2||step.thresh!==thresholdOf(step.strength))throw new VideoGradfunError('Invalid gradfun settings');};
/** config_input radii per plane; filter_frame filters a plane only when min(w,h) > 2r. */
function gradfunLayout(pixelFormat:string,width:number,height:number,step:GradfunStep){
 checkStep(step);const layout=pixelLayout(pixelFormat,width,height),shift=chroma[layout.pixelFormat];if(!shift)throw new VideoGradfunError('Gradfun pixel format is not supported');
 const chromaR=Math.min(32,Math.max(4,((((step.radius>>shift[0])+(step.radius>>shift[1]))>>1)+1)&~1));
 const radii=layout.planes.map((plane,index)=>{const r=index?chromaR:step.radius;return Math.min(plane.width,plane.height)>2*r?r:0;});
 // With exactly 2r+1 rows the main loop never blurs, so native filters with the stale ring and dc state of an earlier plane or frame.
 if(layout.planes.some((plane,index)=>radii[index]&&plane.height===2*radii[index]!+1))throw new VideoGradfunError('Gradfun planes exactly 2*radius+1 rows tall are not implemented');
 return {layout,radii};
}
/** filter(): the r-row ring of cumulative 2x2 half-row sums, the sliding horizontal box, and ff_gradfun_filter_line_c per row. */
function filterPlane(src:Uint8Array,stride:number,dst:Uint8Array,w:number,h:number,r:number,thresh:number,signal?:AbortSignal){
 const half=w>>1,ring=new Uint16Array(r*half),O=16,dc=new Uint16Array(O+half+r+2),factor=Math.floor(2097152/(r*r)),base=O-(r>>1);
 const line=(y:number)=>{
  signal?.throwIfAborted();const row=y*stride,out=y*w,d=dither[y&7]!;
  for(let x=0;x<w;x++){
   let pix=src[row+x]!<<7;const delta=dc[base+(x>>1)]!-pix;let m=(Math.abs(delta)*thresh)>>16;m=Math.max(0,127-m);m=(m*m*delta)>>14;pix+=m+d[x&7]!;
   const v=pix>>7;dst[out+x]=v<0?0:v>255?255:v;
  }
 };
 // ff_gradfun_blur_line_c for y<r: rows 2y and 2y+1 into ring slot y (slot -1 reads as zero). Their dc writes are overwritten by the first main blur.
 for(let y=0;y<r;y++){signal?.throwIfAborted();const row=2*y*stride,b0=y*half,b1=(y-1)*half;for(let x=0;x<half;x++)ring[b0+x]=(y?ring[b1+x]!:0)+src[row+2*x]!+src[row+2*x+1]!+src[row+stride+2*x]!+src[row+stride+2*x+1]!;}
 let y=r;
 for(;;){
  if(y+1<h-r){
   const mod=((y+r)>>1)%r,b0=mod*half,b1=(mod?mod-1:r-1)*half,row=(y+r)*stride;
   for(let x=0;x<half;x++){const v=ring[b1+x]!+src[row+2*x]!+src[row+2*x+1]!+src[row+stride+2*x]!+src[row+stride+2*x+1]!,old=ring[b0+x]!;ring[b0+x]=v;dc[O+x]=v-old;}
   let x=0,v=0;for(;x<r;x++)v+=dc[O+x]!;
   for(;x<half;x++){v+=dc[O+x]!-dc[O+x-r]!;dc[O+x-r]=Math.floor(v*factor/65536);}
   for(const end=(w+r+1)>>1;x<end;x++)dc[O+x-r]=Math.floor(v*factor/65536);
   for(x=-(r>>1);x<0;x++)dc[O+x]=dc[O]!;
  }
  if(y===r)for(let k=0;k<r;k++)line(k);
  line(y);if(++y>=h)break;line(y);if(++y>=h)break;
 }
}
/** filter_frame into owned tight planes: planes with min(w,h) <= 2r are copied. */
export function gradfunVideoFrame(frame:VideoFrameData,step:GradfunStep,options:Pick<VideoFrameOptions,'maxFrameBytes'|'signal'>):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {layout,radii}=gradfunLayout(frame.pixelFormat,frame.width,frame.height,step);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoGradfunError('Gradfun frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoGradfunError('Invalid gradfun plane count');
 let resident=0n,scratch=0;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoGradfunError('Invalid gradfun plane stride or storage');
  resident+=BigInt(input.length);const r=radii[index]!;if(r)scratch=Math.max(scratch,2*(r*(plane.width>>1)+(plane.width>>1)+r+18));
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoGradfunError('Gradfun input plane storage exceeds allocation limit');
 if(scratch>maxFrameBytes)throw new VideoGradfunError('Gradfun blur buffer exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoGradfunError('Invalid gradfun timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const src=frame.planes[index]!,stride=frame.linesizes[index]!,target=data.subarray(plane.offset,plane.offset+plane.bytes),r=radii[index]!;
  if(r){filterPlane(src,stride,target,plane.width,plane.height,r,step.thresh,signal);continue;}
  for(let y=0;y<plane.height;y++){signal?.throwIfAborted();target.set(src.subarray(y*stride,y*stride+plane.width),y*plane.width);}
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
export const gradfunOperator=defineVideoOperator<GradfunStep>({name:'gradfun',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['gradfun','gradfun=strength=3:radius=4,hflip','scale=24:20,gradfun=64:5'],
 parse:token=>singlePad(parseGradfunOptions(token.options)),
 formats:()=>gradfunPixelFormats,
 geometry:(step,[input])=>{gradfunLayout(input!.format,input!.width,input!.height,step);return {width:input!.width,height:input!.height};},
 frame:(frame,step,options)=>gradfunVideoFrame(frame,step,options)});
