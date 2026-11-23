// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from FFmpeg libswscale/swscale.c, output.c, vscale.c and
// x86/swscale_template.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (C) 2001-2012 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2015 Pedro Arthur <bygrandao@gmail.com>
// See ../NOTICE and ../LICENSES/LGPL-2.1-or-later.txt.
import type {PixelLayout,VideoFrameData} from '@edge-ffmpeg/avutil';
import type {ChromaAxis} from './chroma-filter.js';
import type {PixelArithmetic} from './inverse.js';
import {frameInverseCoefficients,defaultInverseCoefficients} from './inverse-coefficients.js';
import type {InverseCoefficients} from './inverse-coefficients.js';
import {table,mmx} from './inverse.js';
export interface InverseResizePlan {readonly full:boolean;readonly chromaWidth:number;readonly alpha:boolean;readonly rowBytes:number;readonly axes:readonly (readonly [number,number,number])[]}
const orders:Readonly<Record<string,string>>={rgb24:'RGB',bgr24:'BGR',rgba:'RGBA',bgra:'BGRA',argb:'ARGB',abgr:'ABGR',gbrp:'GBR'};
export function inverseResizePlan(input:PixelLayout,output:PixelLayout):InverseResizePlan{
 const full=output.width%2===1||output.pixelFormat==='gbrp'||input.pixelFormat==='yuv444p',chromaWidth=full?output.width:output.width/2,alpha=input.pixelFormat==='yuva420p'&&orders[output.pixelFormat]!.includes('A');
 return {full,chromaWidth,alpha,rowBytes:4*(output.width+2*chromaWidth+(alpha?output.width:0)),axes:[[input.width,output.width,16384],[input.planes[1]!.width,chromaWidth,16384],[input.height,output.height,4096],[input.planes[1]!.height,output.height,4096]]};
}
const clip=(value:number)=>Math.max(0,Math.min(255,value)),wrap=(value:number)=>(value<<16)>>16;
function matrix(component:number,y:number,u:number,v:number,c:InverseCoefficients=defaultInverseCoefficients):number{
 const sum=(y-c.yOffset*512)*c.luma+(component===0?(v-65536)*c.vr:component===1?(u-65536)*c.ug+(v-65536)*c.vg:(u-65536)*c.ub)+2097152;
 return clip((sum|0)>>22);
}
/** Shared filtered output rows, explicit scalar/MMXEXT stages and final-row C fallback. */
export function renderInverseResize(frame:VideoFrameData,input:PixelLayout,output:PixelLayout,plan:InverseResizePlan,axis:(one:number,src:number,dst:number)=>ChromaAxis|null,arithmetic:PixelArithmetic,signal?:AbortSignal):Uint8Array{
 const c=frameInverseCoefficients(frame.metadata);
 const {width,height}=output,order=orders[output.pixelFormat]!,{full,chromaWidth,alpha}=plan,hy=axis(16384,input.width,width),hc=axis(16384,input.planes[1]!.width,chromaWidth),vy=axis(4096,input.height,height),vc=axis(4096,input.planes[1]!.height,height),data=new Uint8Array(output.bytes),rows=[new Int32Array(width),new Int32Array(chromaWidth),new Int32Array(chromaWidth),...(alpha?[new Int32Array(width)]:[])];
 type Name='Y'|'U'|'V'|'A';const names:readonly Name[]=alpha?['Y','U','V','A']:['Y','U','V'];
 const read=(name:Name,y:number,x:number)=>{const semi=(name==='U'||name==='V')&&(input.pixelFormat==='nv12'||input.pixelFormat==='nv21'),plane=name==='Y'?0:name==='A'?3:semi?1:name==='U'?1:2,offset=semi?(input.pixelFormat==='nv12'?name==='U'?0:1:name==='U'?1:0):0;return frame.planes[plane]![y*frame.linesizes[plane]!+x*(semi?2:1)+offset]!;};
 const horizontal=(name:Name,y:number,x:number)=>{
  const h=name==='U'||name==='V'?hc:hy;let sum=0;
  if(h)for(let k=0;k<h.taps;k++){if((k&4095)===0)signal?.throwIfAborted();const coefficient=h.coefficients[x*h.taps+k]!;if(coefficient!==0)sum+=read(name,y,h.positions[x]!+k)*coefficient;}else sum=read(name,y,x)*16384;
  return Math.min(32767,Math.floor(sum/128));
 };
 const taps=(v:ChromaAxis|null)=>v?.taps??1,second=(v:ChromaAxis|null,y:number)=>v?.coefficients[y*v.taps+1]??0,valid=(v:ChromaAxis|null,y:number)=>taps(v)===1||taps(v)===2&&v!.coefficients[y*2]!+second(v,y)===4096&&second(v,y)>=0&&second(v,y)<=4096;
 const vertical=(name:Name,y:number,x:number,bias:number)=>{
  const v=name==='U'||name==='V'?vc:vy;let sum=bias;
  for(let j=0;j<taps(v);j++){if((j&4095)===0)signal?.throwIfAborted();const coefficient=v?.coefficients[y*v.taps+j]??4096;if(coefficient!==0)sum+=horizontal(name,(v?.positions[y]??y)+j,x)*coefficient;}
  return sum|0;
 };
 for(let y=0;y<height;y++){
  signal?.throwIfAborted();const mode=output.pixelFormat==='gbrp'?'general':taps(vy)===1&&valid(vc,y)?'one':taps(vy)===2&&taps(vc)===2&&valid(vy,y)&&valid(vc,y)?'two':'general',useMmx=arithmetic==='x86_64'&&!full&&y<height-2&&(['bgra','bgr24'].includes(output.pixelFormat)||output.pixelFormat==='rgba'&&mode==='general');
  const q3=(name:Name,x:number)=>{
   const v=name==='U'||name==='V'?vc:vy,first=v?.positions[y]??y;
   if(mode==='one'){
    if(name==='Y'||name==='A'||taps(vc)===1||second(vc,y)<2048)return horizontal(name,first,x)>>4;
    return ((horizontal(name,first,x)+horizontal(name,first+1,x))&65535)>>>5;
   }
   if(mode==='two'){const left=horizontal(name,first,x),right=horizontal(name,first+1,x);return wrap(Math.floor(wrap(left-right)*v!.coefficients[y*2]!/65536)+(right>>4));}
   let sum=4;for(let j=0;j<taps(v);j++){if((j&4095)===0)signal?.throwIfAborted();const coefficient=v?.coefficients[y*taps(v)+j]??4096;if(coefficient!==0)sum=wrap(sum+Math.floor(horizontal(name,first+j,x)*coefficient/65536));}return sum;
  };
  for(const [component,name]of names.entries()){
   const row=rows[component]!;
   for(let x=0;x<row.length;x++){
    if((x&4095)===0)signal?.throwIfAborted();let value:number;
    if(name==='A')value=useMmx?clip(mode==='one'?horizontal('A',vy?.positions[y]??y,x)>>7:q3('A',x)>>3):!full&&mode==='one'&&(taps(vc)===1||second(vc,y)===0)?clip((horizontal('A',vy?.positions[y]??y,x)*255+16384)>>15):clip(vertical('A',y,x,!full&&mode==='two'?0:262144)>>19);
    else value=useMmx?q3(name,x):full?vertical(name,y,x,mode==='general'?512:0)>>10:vertical(name,y,x,mode==='two'?0:262144)>>19;
    row[x]=value;
   }
  }
  const convert=useMmx?mmx:full?matrix:table;
  for(let x=0;x<width;x++){
   if((x&4095)===0)signal?.throwIfAborted();const cx=full?x:Math.floor(x/2),Y=rows[0]![x]!,U=rows[1]![cx]!,V=rows[2]![cx]!,r=convert(0,Y,U,V,c),g=convert(1,Y,U,V,c),b=convert(2,Y,U,V,c);
   for(let component=0;component<order.length;component++){const name=order[component],value=name==='R'?r:name==='G'?g:name==='B'?b:alpha?rows[3]![x]!:255;data[output.pixelFormat==='gbrp'?output.planes[component]!.offset+y*width+x:y*output.planes[0]!.rowBytes+x*order.length+component]=value;}
  }
 }
 return data;
}
