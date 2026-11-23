// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted numeric paths from FFmpeg libswscale/yuv2rgb.c, output.c,
// aarch64/swscale_unscaled.c, aarch64/yuv2rgb_neon.S,
// x86/swscale_template.c, x86/swscale.c, swscale.c and vscale.c at commit
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (C) 2009 Konstantin Shishkov
// Copyright (C) 2001-2012 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2001-2011 Michael Niedermayer <michaelni@gmx.at>
// Copyright (C) 2015 Pedro Arthur <bygrandao@gmail.com>
// Copyright (c) 2016 Matthieu Bouron <matthieu.bouron stupeflix.com>
// Copyright (c) 2016 Clément Bœsch <clement stupeflix.com>
// Copyright (c) 2026 Ramiro Polla
// See ../NOTICE and ../LICENSES/LGPL-2.1-or-later.txt.
import {defaultInverseCoefficients} from './inverse-coefficients.js';
import type {InverseCoefficients} from './inverse-coefficients.js';
import {chromaAxis,chromaRow,chromaStateBytes} from './chroma-filter.js';
export class UnstablePixelReferenceError extends Error {}
export type PixelArithmetic='aarch64'|'scalar'|'x86_64';
export interface InversePlan {readonly kind:'neon'|'table'|'filtered';readonly mmx:'none'|'packed'|'general';readonly full:boolean;readonly width:number;readonly height:number;readonly sw:number;readonly sh:number;readonly dw:number;readonly stateBytes:number;readonly planarOutput:boolean}
export function inversePlan(source:string,destination:string,width:number,height:number,arithmetic:PixelArithmetic):InversePlan{
 if(!['aarch64','scalar','x86_64'].includes(arithmetic))throw new RangeError('Invalid pixel arithmetic profile');
 if(arithmetic==='aarch64'&&['nv12','nv21'].includes(source)&&width%16===0&&height%2===0)throw new UnstablePixelReferenceError('Default aligned NV12/NV21 to RGB reference path is nondeterministic; explicit scalar arithmetic (-cpuflags 0 in CLI) is required');
 const planar=['yuv420p','yuva420p','yuv422p'].includes(source),sw=Math.ceil(width/2),sh=source==='yuv422p'?height:Math.ceil(height/2),full=width%2===1||destination==='gbrp',dw=full?width:sw;
 const kind=height%2===0&&(planar||arithmetic==='aarch64'&&width%16===0)?arithmetic==='aarch64'&&width%16===0?'neon':'table':'filtered';
 const mmx=arithmetic==='x86_64'&&kind==='filtered'&&!full?['bgra','bgr24'].includes(destination)?'packed':destination==='rgba'?'general':'none':'none';
 return {planarOutput:destination==='gbrp',kind,mmx,full,width,height,sw,sh,dw,stateBytes:kind==='filtered'?chromaStateBytes(sw,sh,dw,height)+8*dw:0};
}
const clip=(value:number)=>Math.max(0,Math.min(255,value));
const tableOffset=(value:number,coefficient:number)=>-Math.floor(coefficient/512)+Math.floor(value*coefficient/65536);
export function table(component:number,y:number,u:number,v:number,c:InverseCoefficients=defaultInverseCoefficients):number{
 u=clip(u);v=clip(v);
 const shift=component===0?tableOffset(v,c.tableVr):component===1?tableOffset(u,c.tableUg)+tableOffset(v,c.tableVg):tableOffset(u,c.tableUb);
 return clip(Math.floor(((y+c.tableBase+shift)*c.tableLuma+c.tableBias+32768)/65536));
}
function neon(component:number,y:number,u:number,v:number,c:InverseCoefficients=defaultInverseCoefficients):number{
 const luma=Math.floor((y-c.yOffset)*c.luma/4096),cb=u-128,cr=v-128;
 const offset=component===0?Math.floor(cr*c.vr/4096):component===1?Math.floor(cb*c.ug/4096)+Math.floor(cr*c.vg/4096):Math.floor(cb*c.ub/4096);
 return clip(Math.floor((luma+offset+1)/2));
}
function full(component:number,y:number,u:number,v:number,c:InverseCoefficients=defaultInverseCoefficients):number{
 const luma=(y*512-c.yOffset*512)*c.luma,cb=u-65536,cr=v-65536;
 const sum=luma+(component===0?cr*c.vr:component===1?cb*c.ug+cr*c.vg:cb*c.ub)+2097152;
 return clip((sum|0)>>22);
}
// Adapted from x86/swscale_template.c: signed multiply-high, Q3 inputs and
// separate green products. This emulates MMXEXT without executing host SIMD.
export function mmx(component:number,y:number,u:number,v:number,c:InverseCoefficients=defaultInverseCoefficients):number{
 const luma=Math.floor((y-c.yOffset*8)*c.luma/65536),cb=u-1024,cr=v-1024;
 return clip(luma+(component===0?Math.floor(cr*c.vr/65536):component===1?Math.floor(cb*c.ug/65536)+Math.floor(cr*c.vg/65536):Math.floor(cb*c.ub/65536)));
}
export function renderInverse(plan:InversePlan,read:(name:'Y'|'U'|'V'|'A',row:number,column:number)=>number,hasAlpha:boolean,write:(row:number,column:number,r:number,g:number,b:number,a:number)=>void,signal?:AbortSignal,c:InverseCoefficients=defaultInverseCoefficients):void{
 const {width,height,sw,sh,dw,kind}=plan;
 if(kind!=='filtered'){
  for(let row=0;row<height;row++)for(let col=0;col<(kind==='table'?width-width%2:width);col++){
   if((col&4095)===0)signal?.throwIfAborted();const y=read('Y',row,col),u=read('U',sh===height?row:Math.floor(row/2),Math.floor(col/2)),v=read('V',sh===height?row:Math.floor(row/2),Math.floor(col/2)),convert=kind==='neon'?neon:table;
   write(row,col,convert(0,y,u,v,c),convert(1,y,u,v,c),convert(2,y,u,v,c),hasAlpha?read('A',row,col):255);
  }
  return;
 }
 const horizontal=chromaAxis(sw,dw,16384,signal),vertical=chromaAxis(sh,height,4096,signal),scratch=new Int16Array(vertical?vertical.taps*dw:0),us=new Int32Array(dw),vs=new Int32Array(dw);
 for(let row=0;row<height;row++){
  signal?.throwIfAborted();
  const taps=vertical?.taps??1,second=vertical?.coefficients[row*taps+1]??0,optimized=taps===1||taps===2&&vertical!.coefficients[row*taps]!+second===4096&&second>=0&&second<=4096;
  if(plan.mmx!=='none'&&row<height-2&&(plan.mmx==='packed'||!optimized)){
   const first=vertical?.positions[row]??row;
   const chroma=(name:'U'|'V',column:number)=>{
    if(optimized)return !vertical||taps===1||second<2048?read(name,first,column)*8:(read(name,first,column)+read(name,first+1,column))*4;
    let sum=4;for(let j=0;j<taps;j++){const coefficient=vertical!.coefficients[row*taps+j]!;if(coefficient!==0)sum+=Math.floor(read(name,first+j,column)*coefficient/512);}return sum;
   };
   for(let col=0;col<width;col++){
    if((col&4095)===0)signal?.throwIfAborted();const x=Math.floor(col/2),y=read('Y',row,col)*8+(optimized?0:4),u=chroma('U',x),v=chroma('V',x);
    write(row,col,mmx(0,y,u,v,c),mmx(1,y,u,v,c),mmx(2,y,u,v,c),hasAlpha?read('A',row,col):255);
   }
   continue;
  }
  chromaRow(row,dw,(y,x)=>read('U',y,x),horizontal,vertical,scratch,(x,value)=>{us[x]=value;},signal,false,plan.full?(plan.planarOutput?'q9-round':'q9'):'byte');
  chromaRow(row,dw,(y,x)=>read('V',y,x),horizontal,vertical,scratch,(x,value)=>{vs[x]=value;},signal,false,plan.full?(plan.planarOutput?'q9-round':'q9'):'byte');
  for(let col=0;col<width;col++){
   if((col&4095)===0)signal?.throwIfAborted();const x=plan.full?col:Math.floor(col/2),y=read('Y',row,col),u=us[x]!,v=vs[x]!;let alpha=hasAlpha?read('A',row,col):255;
   if(hasAlpha&&!plan.full&&(!vertical||vertical.taps===1||vertical.taps===2&&vertical.coefficients[row*2+1]===0))alpha=clip(Math.floor((alpha*255+128)/256));
   const convert=plan.full?full:table;write(row,col,convert(0,y,u,v,c),convert(1,y,u,v,c),convert(2,y,u,v,c),alpha);
  }
 }
}
