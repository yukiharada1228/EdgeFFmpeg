// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted fixed-point stages from FFmpeg libswscale/input.c, swscale.c,
// output.c and vscale.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (C) 2001-2012 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2015 Pedro Arthur <bygrandao@gmail.com>
// See ../NOTICE and ../LICENSES/LGPL-2.1-or-later.txt.
import type {VideoFrameData,PixelLayout} from '@edge-ffmpeg/avutil';
import type {ChromaAxis} from './chroma-filter.js';
import {rgbLuma,rgbChromaQ6} from './color.js';
const orders:Readonly<Record<string,string>>={rgb24:'RGB',bgr24:'BGR',rgba:'RGBA',bgra:'BGRA',argb:'ARGB',abgr:'ABGR',gbrp:'GBR'};
export function isRgbResizeFormat(format:string):boolean{return Object.hasOwn(orders,format);}
export function rgbResizeRowBytes(format:string,width:number,destination:string=format):number{return (orders[format]!.includes('A')&&orders[destination]!.includes('A')?16:12)*width;}
export function renderRgbResize(frame:VideoFrameData,output:PixelLayout,axis:(one:number,src:number,dst:number)=>ChromaAxis|null,signal?:AbortSignal):Uint8Array{
 const {width:sw,height:sh}=frame,{width:dw,height:dh}=output,order=orders[frame.pixelFormat]!,sourcePlanar=frame.pixelFormat==='gbrp',destinationOrder=orders[output.pixelFormat]!,planar=output.pixelFormat==='gbrp',hasAlpha=order.includes('A')&&destinationOrder.includes('A'),data=new Uint8Array(output.bytes);
 const read=(name:string,y:number,x:number)=>{const component=order.indexOf(name);return sourcePlanar?frame.planes[component]![y*frame.linesizes[component]!+x]!:frame.planes[0]![y*frame.linesizes[0]!+x*order.length+component]!;};
 if(sw===dw&&sh===dh){
  for(const [index,plane]of output.planes.entries())for(let y=0;y<sh;y++){signal?.throwIfAborted();data.set(frame.planes[index]!.subarray(y*frame.linesizes[index]!,y*frame.linesizes[index]!+plane.rowBytes),plane.offset+y*plane.rowBytes);}return data;
 }
 const half=sw%2===0&&dw<=sw/2,cw=half?sw/2:sw,horizontal=axis(16384,sw,dw),chroma=axis(16384,cw,dw),vertical=axis(4096,sh,dh),rows=Array.from({length:hasAlpha?4:3},()=>new Int32Array(dw));
 const q6=(name:string,y:number,x:number)=>{
  if(name==='A'){const value=read('A',y,x);return value*64+(value>>2);}
  const paired=half&&name!=='Y';let r=read('R',y,x*(paired?2:1)),g=read('G',y,x*(paired?2:1)),b=read('B',y,x*(paired?2:1));
  if(paired){r+=read('R',y,2*x+1);g+=read('G',y,2*x+1);b+=read('B',y,2*x+1);}
  return name==='Y'?Math.floor((rgbLuma(r,g,b)+524544)/512):rgbChromaQ6(name as 'U'|'V',r,g,b,paired?2:1);
 };
 const clip=(value:number)=>Math.max(0,Math.min(255,value));
 for(let y=0;y<dh;y++){
  signal?.throwIfAborted();const taps=vertical?.taps??1,first=vertical?.positions[y]??y,second=vertical?.coefficients[y*taps+1]??0,optimized=taps===1||taps===2&&vertical!.coefficients[y*taps]!+second===4096&&second>=0&&second<=4096;
  for(const [component,name]of ['Y','U','V',...(hasAlpha?['A']:[])].entries()){
   const h=name==='U'||name==='V'?chroma:horizontal,row=rows[component]!;row.fill(name==='A'?262144:planar||!optimized?512:0);
   for(let j=0;j<taps;j++){
    const coefficient=vertical?.coefficients[y*taps+j]??4096;if(coefficient===0)continue;
    for(let x=0;x<dw;x++){
     if((x&4095)===0)signal?.throwIfAborted();let sum=0;
     if(h)for(let k=0;k<h.taps;k++){if((k&4095)===0)signal?.throwIfAborted();const weight=h.coefficients[x*h.taps+k]!;if(weight!==0)sum+=q6(name,first+j,h.positions[x]!+k)*weight;}
     else sum=q6(name,first+j,x)*16384;
     row[x]=row[x]!+Math.min(32767,Math.floor(sum/8192))*coefficient;
    }
   }
   for(let x=0;x<dw;x++)row[x]=name==='A'?clip(row[x]!>>19):row[x]!>>10;
  }
  for(let x=0;x<dw;x++){
   if((x&4095)===0)signal?.throwIfAborted();const Y=(rows[0]![x]!-8192)*9539,U=rows[1]![x]!-65536,V=rows[2]![x]!-65536,r=clip(((Y+V*13075+2097152)|0)>>22),g=clip(((Y+U*-3209+V*-6660+2097152)|0)>>22),b=clip(((Y+U*16525+2097152)|0)>>22);
   for(let component=0;component<destinationOrder.length;component++){const name=destinationOrder[component],value=name==='R'?r:name==='G'?g:name==='B'?b:hasAlpha?rows[3]![x]!:255;data[planar?output.planes[component]!.offset+y*dw+x:y*output.planes[0]!.rowBytes+x*destinationOrder.length+component]=value;}
  }
 }
 return data;
}
