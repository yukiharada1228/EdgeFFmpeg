// SPDX-License-Identifier: LGPL-2.1-or-later
// Border fill modes, border checks, chroma shifts and colour setup adapted from pinned FFmpeg
// libavfilter/vf_fillborders.c, libavutil/parseutils.c av_parse_color and libavutil/colorspace.h
// at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE-FILLBORDERS.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
export class VideoFillbordersError extends Error {}
export type FillbordersMode='smear'|'mirror'|'fixed'|'reflect'|'wrap'|'fade'|'margins';
export interface VideoFillbordersSettings {readonly left:number;readonly right:number;readonly top:number;readonly bottom:number;readonly mode:FillbordersMode;readonly color:readonly [number,number,number,number]}
export interface VideoFillbordersOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** Pinned fillborders pix_fmts restricted to the declared eight-bit layouts. */
export const fillbordersPixelFormats:readonly string[]=Object.freeze(['yuv444p','yuv422p','yuv420p','yuva420p','gbrp','gray']);
const modes:readonly FillbordersMode[]=Object.freeze(['smear','mirror','fixed','reflect','wrap','fade','margins']);
// log2 chroma shifts per format; gbrp planes are G, B, R, so the rgba map is R:2 G:0 B:1.
const chroma:Readonly<Record<string,readonly [number,number]>>={yuv444p:[0,0],yuv422p:[1,0],yuv420p:[1,1],yuva420p:[1,1],gbrp:[0,0],gray:[0,0]};
function border(value:string):number{
 if(!/^\d{1,10}$/.test(value)||Number(value)>2147483647)throw new VideoFillbordersError('Only decimal fillborders borders from 0 to 2147483647 are implemented');return Number(value);
}
/** av_parse_color restricted to black, 0xRRGGBB[AA], #RRGGBB[AA] and an @0xHH or @decimal alpha; names and random are refused. */
export function parseFillbordersColor(value:string):readonly [number,number,number,number]{
 const at=value.indexOf('@'),body=at<0?value:value.slice(0,at),alpha=at<0?null:value.slice(at+1);let rgba:[number,number,number,number];
 if(body==='black')rgba=[0,0,0,255];
 else{const match=/^(?:0x|#)([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(body);if(!match)throw new VideoFillbordersError('Only black, 0xRRGGBB[AA] and #RRGGBB[AA] fillborders colors are implemented');const hex=match[1]!,n=Number.parseInt(hex.slice(0,6),16);rgba=[n>>16&255,n>>8&255,n&255,hex.length===8?Number.parseInt(hex.slice(6),16):255];}
 if(alpha!==null){
  let a:number;
  if(/^0x[0-9a-fA-F]{1,8}$/.test(alpha))a=Number.parseInt(alpha.slice(2),16);
  else if(/^(?:0(?:\.\d{1,17})?|1(?:\.0{1,17})?|\.\d{1,17})$/.test(alpha))a=Math.trunc(255*Number(alpha));
  else throw new VideoFillbordersError('Only 0xHH and decimal fillborders alpha values are implemented');
  if(a>255)throw new VideoFillbordersError('Invalid alpha value specifier');rgba[3]=a;
 }
 return Object.freeze(rgba);
}
export function parseFillbordersOptions(options:string|null):VideoFillbordersSettings{
 let left=0,right=0,top=0,bottom=0,mode:FillbordersMode='smear',color=parseFillbordersColor('black');
 for(const option of filterOptions(options,['left','right','top','bottom','mode','color'])){
  if(option.key==='left')left=border(option.value);else if(option.key==='right')right=border(option.value);else if(option.key==='top')top=border(option.value);else if(option.key==='bottom')bottom=border(option.value);
  else if(option.key==='mode'){const named=modes.find(name=>name===option.value),index=/^\d$/.test(option.value)?modes[Number(option.value)]:undefined;if(!named&&!index)throw new VideoFillbordersError('Only declared fillborders modes and their indices are implemented');mode=named??index!;}
  else if(option.key==='color')color=parseFillbordersColor(option.value);
  else if(option.key==='enable')throw new VideoFillbordersError('Fillborders timeline expressions are not implemented');
  else throw new VideoFillbordersError('Unsupported fillborders option');
 }
 return Object.freeze({left,right,top,bottom,mode,color});
}
interface Plane {readonly width:number;readonly height:number;readonly left:number;readonly right:number;readonly top:number;readonly bottom:number;readonly fill:number}
const FIX=(x:number)=>Math.trunc(x*1024+0.5);
/** config_input: native border checks, chroma border shifts, CCIR fill colours or the gbrp rgba map, and the refusals of out-of-plane reads. */
export function fillbordersPlanes(pixelFormat:string,width:number,height:number,settings:VideoFillbordersSettings):readonly Plane[]{
 const shifts=chroma[pixelFormat];if(!shifts)throw new VideoFillbordersError('Fillborders pixel format is not supported');
 const {left,right,top,bottom,mode,color}=settings;if(![left,right,top,bottom].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647)||!modes.includes(mode))throw new VideoFillbordersError('Invalid fillborders settings');
 if(width<left+right||width<=left||width<=right||height<top+bottom||height<=top||height<=bottom||width<left*2||width<right*2||height<top*2||height<bottom*2)throw new VideoFillbordersError('Borders are bigger than input frame size.');
 const [r,g,b,a]=color,[sw,sh]=shifts,count=pixelFormat==='gray'?1:pixelFormat==='yuva420p'?4:3;
 const y=FIX(0.299*219/255)*r+FIX(0.587*219/255)*g+FIX(0.114*219/255)*b+(512+(16<<10))>>10;
 const u=(-FIX(0.16874*224/255)*r-FIX(0.33126*224/255)*g+FIX(0.5*224/255)*b+512-1>>10)+128,v=(FIX(0.5*224/255)*r-FIX(0.41869*224/255)*g-FIX(0.08131*224/255)*b+512-1>>10)+128;
 const fills=pixelFormat==='gbrp'?[g,b,r]:[y,u,v,a];
 const planes=Array.from({length:count},(_,index):Plane=>{const c=index===1||index===2,cw=c?sw:0,ch=c?sh:0;return {width:-(-width>>cw),height:-(-height>>ch),left:left>>cw,right:right>>cw,top:top>>ch,bottom:bottom>>ch,fill:fills[index]!&255};});
 // Native reflect reads one sample past the plane when a border is half of it; margins copies the last eight samples of a row.
 if(mode==='reflect'&&planes.some(p=>p.left&&2*p.left>=p.width||p.right&&2*p.right>=p.width||p.top&&2*p.top>=p.height||p.bottom&&2*p.bottom>=p.height))throw new VideoFillbordersError('Fillborders reflect borders reaching half of a plane read outside it and are not implemented');
 if(mode==='margins'&&planes.some(p=>p.width<8))throw new VideoFillbordersError('Fillborders margins on planes narrower than 8 samples are not implemented');
 return planes;
}
const lerp=(fill:number,src:number,pos:number,size:number)=>{const value=(Math.trunc(fill*256*pos/size)+Math.trunc(src*256*(size-pos)/size))>>8;return value<0?0:value>255?255:value;};
/** The native in-place loops over one tight plane, in native order. */
function fillPlane(d:Uint8Array,o:number,p:Plane,mode:FillbordersMode,signal?:AbortSignal):void{
 const {width:w,height:h,left:l,right:r,top:t,bottom:b,fill}=p,row=(y:number)=>o+y*w,copy=(to:number,from:number)=>d.copyWithin(row(to),row(from),row(from)+w);
 switch(mode){
  case 'smear':
   for(let y=t;y<h-b;y++){const s=row(y);d.fill(d[s+l]!,s,s+l);d.fill(d[s+w-r-1]!,s+w-r,s+w);}
   for(let y=0;y<t;y++)copy(y,t);for(let y=h-b;y<h;y++)copy(y,h-b-1);break;
  case 'mirror':
   for(let y=t;y<h-b;y++){const s=row(y);for(let x=0;x<l;x++)d[s+x]=d[s+l*2-1-x]!;for(let x=0;x<r;x++)d[s+w-r+x]=d[s+w-r-1-x]!;}
   for(let y=0;y<t;y++)copy(y,t*2-1-y);for(let y=0;y<b;y++)copy(h-b+y,h-b-1-y);break;
  case 'fixed':
   for(let y=t;y<h-b;y++){const s=row(y);d.fill(fill,s,s+l);d.fill(fill,s+w-r,s+w);}
   for(let y=0;y<t;y++)d.fill(fill,row(y),row(y)+w);for(let y=h-b;y<h;y++)d.fill(fill,row(y),row(y)+w);break;
  case 'reflect':
   for(let y=t;y<h-b;y++){const s=row(y);for(let x=0;x<l;x++)d[s+x]=d[s+l*2-x]!;for(let x=0;x<r;x++)d[s+w-r+x]=d[s+w-r-2-x]!;}
   for(let y=0;y<t;y++)copy(y,t*2-y);for(let y=0;y<b;y++)copy(h-b+y,h-b-2-y);break;
  case 'wrap':
   for(let y=t;y<h-b;y++){const s=row(y);for(let x=0;x<l;x++)d[s+x]=d[s+w-r-l+x]!;for(let x=0;x<r;x++)d[s+w-r+x]=d[s+l+x]!;}
   for(let y=0;y<t;y++)copy(y,h-b-t+y);for(let y=0;y<b;y++)copy(h-b+y,t+y);break;
  case 'fade':
   for(let y=0;y<t;y++){const s=row(y);for(let x=0;x<w;x++)d[s+x]=lerp(fill,d[s+x]!,t-y,t);}
   for(let y=h-b;y<h;y++){const s=row(y);for(let x=0;x<w;x++)d[s+x]=lerp(fill,d[s+x]!,y-(h-b),b);}
   for(let y=0;y<h;y++){if((y&255)===0)signal?.throwIfAborted();const s=row(y);for(let x=0;x<l;x++)d[s+x]=lerp(fill,d[s+x]!,l-x,l);for(let x=0;x<r;x++)d[s+w-r+x]=lerp(fill,d[s+w-r+x]!,x,r);}
   break;
  case 'margins':{
   for(let y=t;y<h-b;y++){const s=row(y);d.fill(d[s+l]!,s,s+l);d.fill(d[s+w-r-1]!,s+w-r,s+w);}
   const blur=(y:number,from:number)=>{const s=row(y),f=row(from);d[s]=d[f]!;d.copyWithin(s+w-8,f+w-8,f+w);for(let x=1;x<w-8;x++)d[s+x]=3*d[f+x-1]!+2*d[f+x]!+3*d[f+x+1]!+4>>3;};
   for(let y=t-1;y>=0;y--){signal?.throwIfAborted();blur(y,y+1);}for(let y=h-b;y<h;y++){signal?.throwIfAborted();blur(y,y-1);}break;
  }
 }
}
/** Materialize a fill into owned tight planes with positive strides; the input frame is never written. */
export function fillbordersVideoFrame(frame:VideoFrameData,settings:VideoFillbordersSettings,options:VideoFillbordersOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),planes=fillbordersPlanes(layout.pixelFormat,frame.width,frame.height,settings);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoFillbordersError('Fillborders frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length||planes.length!==layout.planes.length)throw new VideoFillbordersError('Invalid fillborders plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoFillbordersError('Invalid fillborders plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoFillbordersError('Fillborders input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoFillbordersError('Invalid fillborders timestamp time base');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index]!,stride=frame.linesizes[index]!;
  for(let y=0;y<plane.height;y++){if((y&255)===0)signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
  fillPlane(data,plane.offset,planes[index]!,settings.mode,signal);
 }
 signal?.throwIfAborted();
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
