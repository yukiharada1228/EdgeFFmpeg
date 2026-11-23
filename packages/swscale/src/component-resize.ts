// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted fixed-point filtering/range stages from FFmpeg libswscale/input.c,
// utils.c, swscale.c and output.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (C) 2001-2012 Michael Niedermayer <michaelni@gmx.at>
// See ../NOTICE and ../LICENSES/LGPL-2.1-or-later.txt.
import type {PixelLayout,VideoFrameData} from '@edge-ffmpeg/avutil';
import type {ChromaAxis} from './chroma-filter.js';
import {isRgbResizeFormat} from './rgb-resize.js';
import {rgbLuma,rgbChromaQ6} from './color.js';
type Name='Y'|'U'|'V'|'A'|'R'|'G'|'B';
interface Component {readonly name:Name;readonly plane:number;readonly step:number;readonly offset:number}
export interface ResizeSample {readonly source:Component|null;readonly target:Component;readonly width:number;readonly height:number;readonly q6:boolean;readonly paired:boolean;readonly range:'full'|'limited'|null;readonly constant:number|null;readonly q9:boolean}
function components(format:string):Component[]{
 const rgb:Record<string,string>={rgb24:'RGB',bgr24:'BGR',rgba:'RGBA',bgra:'BGRA',argb:'ARGB',abgr:'ABGR',gbrp:'GBR'};
 if(Object.hasOwn(rgb,format))return [...rgb[format]!].map((name,i)=>({name:name as Name,plane:format==='gbrp'?i:0,step:format==='gbrp'?1:rgb[format]!.length,offset:format==='gbrp'?0:i}));
 if(format==='gray')return [{name:'Y',plane:0,step:1,offset:0}];
 if(format==='nv12'||format==='nv21')return [{name:'Y',plane:0,step:1,offset:0},{name:'U',plane:1,step:2,offset:format==='nv12'?0:1},{name:'V',plane:1,step:2,offset:format==='nv12'?1:0}];
 return [...(format==='yuva420p'?'YUVA':'YUV')].map((name,i)=>({name:name as Name,plane:i,step:1,offset:0}));
}
export function componentResizeSamples(input:PixelLayout,output:PixelLayout):readonly ResizeSample[]{
 const source=components(input.pixelFormat),rgb=isRgbResizeFormat(input.pixelFormat),gray=input.pixelFormat==='gray',q9=gray&&isRgbResizeFormat(output.pixelFormat);
 return components(output.pixelFormat).map(target=>{
  const name=q9&&target.name!=='A'?'Y':target.name,previous=source.find(c=>c.name===name)??null;
  if(gray&&(name==='U'||name==='V')||name==='A'&&!previous)return {source:null,target,width:1,height:1,q6:false,paired:false,range:null,constant:name==='A'?255:128,q9:false};
  if(rgb&&name!=='A'){
   // Native chooses paired RGB chroma from the floor-shifted destination
   // width, before rounding the actual chroma plane width upward.
   const subsampled=['yuv420p','yuv422p','yuva420p','nv12','nv21'].includes(output.pixelFormat);
   const paired=(name==='U'||name==='V')&&input.width%2===0&&Math.floor(output.width/(subsampled?2:1))<=input.width/2;
   return {source:null,target,width:paired?input.width/2:input.width,height:input.height,q6:true,paired,range:output.pixelFormat==='gray'?'full':null,constant:null,q9:false};
  }
  if(!previous)throw new RangeError('Unsupported resize component');
  const p=input.planes[previous.plane]!;
  return {source:previous,target,width:p.width,height:p.height,q6:rgb,paired:false,range:gray&&output.pixelFormat!=='gray'&&!q9?'limited':output.pixelFormat==='gray'&&!gray?'full':null,constant:null,q9};
 });
}
/** Sequential component evaluation with one reusable signed32 output row. */
export function renderComponentResize(frame:VideoFrameData,output:PixelLayout,samples:readonly ResizeSample[],rowWidth:number,axis:(one:number,src:number,dst:number)=>ChromaAxis|null,signal?:AbortSignal):Uint8Array{
 const data=new Uint8Array(output.bytes),sums=new Int32Array(rowWidth),rgb=components(frame.pixelFormat),read=(name:Name,y:number,x:number)=>{const c=rgb.find(c=>c.name===name)!;return frame.planes[c.plane]![y*frame.linesizes[c.plane]!+x*c.step+c.offset]!;},clip=(value:number)=>Math.max(0,Math.min(255,value));
 for(const sample of samples){
  const {target}=sample,q=output.planes[target.plane]!,h=sample.constant===null?axis(16384,sample.width,q.width):null,v=sample.constant===null?axis(4096,sample.height,q.height):null;
  const readSample=(y:number,x:number)=>{
   if(!sample.q6){const c=sample.source!;return frame.planes[c.plane]![y*frame.linesizes[c.plane]!+x*c.step+c.offset]!;}
   const name=target.name;if(name==='A'){const alpha=read('A',y,x);return alpha*64+(alpha>>2);}
   let r=read('R',y,x*(sample.paired?2:1)),g=read('G',y,x*(sample.paired?2:1)),b=read('B',y,x*(sample.paired?2:1));
   if(sample.paired){r+=read('R',y,2*x+1);g+=read('G',y,2*x+1);b+=read('B',y,2*x+1);}
   return name==='Y'?Math.floor((rgbLuma(r,g,b)+524544)/512):rgbChromaQ6(name as 'U'|'V',r,g,b,sample.paired?2:1);
  };
  const horizontal=(y:number,x:number)=>{
   let sum=0;if(h)for(let k=0;k<h.taps;k++){if((k&4095)===0)signal?.throwIfAborted();const coefficient=h.coefficients[x*h.taps+k]!;if(coefficient!==0)sum+=readSample(y,h.positions[x]!+k)*coefficient;}else sum=readSample(y,x)*16384;
   let value=Math.min(32767,Math.floor(sum/(sample.q6?8192:128)));
   if(sample.range==='full'&&frame.metadata.colorRange!==2)value=Math.min(32767,Math.floor((value*19078-39084288)/16384));else if(sample.range==='limited')value=Math.floor((value*14071+33561472)/16384);
   return value;
  };
  for(let y=0;y<q.height;y++){
   signal?.throwIfAborted();const write=(x:number,value:number)=>{data[q.offset+y*q.rowBytes+x*target.step+target.offset]=value;};
   if(sample.constant!==null){for(let x=0;x<q.width;x++){if((x&4095)===0)signal?.throwIfAborted();write(x,sample.constant);}continue;}
   const convert=(sum:number)=>sample.q9?clip(((((sum|0)>>10)*8192+2097152)|0)>>22):clip((sum|0)>>19);
   if(!v){for(let x=0;x<q.width;x++){if((x&4095)===0)signal?.throwIfAborted();write(x,convert(horizontal(y,x)*4096+(sample.q9?0:262144)));}continue;}
   const second=v.coefficients[y*v.taps+1]??0,optimized=v.taps===1||v.taps===2&&v.coefficients[y*v.taps]!+second===4096&&second>=0&&second<=4096;
   sums.fill(sample.q9?(output.pixelFormat==='gbrp'||!optimized?512:0):262144);
   for(let j=0;j<v.taps;j++){
    const coefficient=v.coefficients[y*v.taps+j]!;if(coefficient===0)continue;
    for(let x=0;x<q.width;x++){if((x&4095)===0)signal?.throwIfAborted();sums[x]=sums[x]!+horizontal(v.positions[y]!+j,x)*coefficient;}
   }
   for(let x=0;x<q.width;x++)write(x,convert(sums[x]!));
  }
 }
 return data;
}
