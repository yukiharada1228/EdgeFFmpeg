// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_colorcontrast.c. See ../../NOTICE-COLORCONTRAST.
import {compileExpression,pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoColorcontrastError extends Error {}
/** The seven AV_OPT_TYPE_FLOAT options in AVOption order, which is also the shorthand order. */
export const colorcontrastOptions=Object.freeze(['rc','gm','by','rcw','gmw','byw','pl'] as const);
export type ColorcontrastOption=typeof colorcontrastOptions[number];
/** Each value is the float the option stores (Math.fround of the range-checked double). */
export type ColorcontrastStep={readonly name:'colorcontrast';readonly rc:number;readonly gm:number;readonly by:number;readonly rcw:number;readonly gmw:number;readonly byw:number;readonly pl:number};
/** The pinned pixel_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const colorcontrastPixelFormats:readonly string[]=Object.freeze('rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0 gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le rgb48le bgr48le rgba64le bgra64le'.split(' '));
/** The eight-bit members with frame storage here: rgb24, bgr24, rgba, bgra, argb, abgr and gbrp. */
const executable:readonly string[]=Object.freeze(colorcontrastPixelFormats.filter(executableFormat));
/** ff_fill_rgba_map byte offsets of R, G, B and config_input's step (nb_components); gbrp is planar (G, B, R planes). */
const packed:Readonly<Record<string,readonly [number,number,number,number]>>={rgb24:[0,1,2,3],bgr24:[2,1,0,3],rgba:[0,1,2,4],bgra:[2,1,0,4],argb:[1,2,3,4],abgr:[3,2,1,4]};
const ranges:Readonly<Record<ColorcontrastOption,readonly [number,number]>>={rc:[-1,1],gm:[-1,1],by:[-1,1],rcw:[0,1],gmw:[0,1],byw:[0,1],pl:[0,1]};
/** set_string_number: av_expr with default, max, min, none and all, write_number's double range check, then the float store. */
function floatOption(key:ColorcontrastOption,text:string):number{
 const [low,high]=ranges[key],constants={default:0,max:high,min:low,none:0,all:-1};let value:number;
 try{value=compileExpression(text,{numericProfile:'linux-x64',constants:Object.keys(constants)})(Float64Array.from(Object.values(constants)));}catch(error){throw new VideoFilterParseError(`Invalid colorcontrast ${key}: ${(error as Error).message}`);}
 // av_expr_parse_and_eval fails on a NaN result: native reports it as unparsable.
 if(Number.isNaN(value))throw new VideoFilterParseError(`Invalid colorcontrast ${key}: unable to parse ${text}`);
 if(!(value>=low&&value<=high))throw new VideoFilterParseError(`Invalid colorcontrast ${key}: value outside ${low}..${high}`);
 return Math.fround(value);
}
/** colorcontrast_options applied in order; enable= and every other option are refused. */
export function parseColorcontrastOptions(options:string|null):ColorcontrastStep{
 const values:Record<ColorcontrastOption,number>={rc:0,gm:0,by:0,rcw:0,gmw:0,byw:0,pl:0};
 for(const option of filterOptions(options,colorcontrastOptions)){
  if((colorcontrastOptions as readonly string[]).includes(option.key))values[option.key as ColorcontrastOption]=floatOption(option.key as ColorcontrastOption,option.value);
  else if(option.key==='enable')throw new VideoFilterParseError('Colorcontrast timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported colorcontrast option');
 }
 return Object.freeze({name:'colorcontrast',...values});
}
const f=Math.fround,FLT_EPSILON=2**-23;
/** One pixel through PROCESS(255.f) in single precision, unfused (x86-64 without FMA): every operation rounds to float.
 * Returns the three av_clip_uint8 results as [r, g, b]. Exported for the unit tests. */
export function colorcontrastPixel(r:number,g:number,b:number,k:{readonly rc:number;readonly gm:number;readonly by:number;readonly gmw:number;readonly byw:number;readonly rcw:number;readonly scale:number;readonly preserve:number}):[number,number,number]{
 const {rc,gm,by,gmw,byw,rcw,scale,preserve}=k;
 const br=f(f(b+r)*0.5),gb=f(f(g+b)*0.5),rg=f(f(r+g)*0.5);
 const gd=f(g-br),bd=f(b-rg),rd=f(r-gb);
 const gdm=f(gd*gm),bdy=f(bd*by),rdc=f(rd*rc);
 const g0=f(g+gdm),b0=f(b-gdm),r0=f(r-gdm);
 const g1=f(g-bdy),b1=f(b+bdy),r1=f(r-bdy);
 const g2=f(g-rdc),b2=f(b-rdc),r2=f(r+rdc);
 // av_clipf(a, 0, 255): FFMIN(FFMAX(a, amin), amax).
 const clipf=(a:number)=>{const low=a>0?a:0;return low<255?low:255;};
 let ng=clipf(f(f(f(f(g0*gmw)+f(g1*byw))+f(g2*rcw))*scale));
 let nb=clipf(f(f(f(f(b0*gmw)+f(b1*byw))+f(b2*rcw))*scale));
 let nr=clipf(f(f(f(f(r0*gmw)+f(r1*byw))+f(r2*rcw))*scale));
 // FFMAX3(a,b,c) = FFMAX(FFMAX(a,b),c); FFMAX(a,b) = a > b ? a : b.
 const max3=(x:number,y:number,z:number)=>{const m=x>y?x:y;return m>z?m:z;},min3=(x:number,y:number,z:number)=>{const m=x>y?y:x;return m>z?z:m;};
 const li=f(max3(r,g,b)+min3(r,g,b)),lo=f(f(max3(nr,ng,nb)+min3(nr,ng,nb))+FLT_EPSILON),lf=f(li/lo);
 const pr=f(nr*lf),pg=f(ng*lf),pb=f(nb*lf);
 // lerpf(v0, v1, f) = v0 + (v1 - v0) * f.
 nr=f(nr+f(f(pr-nr)*preserve));ng=f(ng+f(f(pg-ng)*preserve));nb=f(nb+f(f(pb-nb)*preserve));
 // av_clip_uint8(int): the float converts to int by truncation first.
 const clip8=(v:number)=>{const t=Math.trunc(v);return t<0?0:t>255?255:t;};
 return [clip8(nr),clip8(ng),clip8(nb)];
}
/** The slice functions' per-frame constants; null when sum <= FLT_EPSILON, where native's row loop never runs (identity). */
export function colorcontrastConstants(step:ColorcontrastStep){
 const sum=f(f(step.gmw+step.byw)+step.rcw);if(!(sum>FLT_EPSILON))return null;
 return Object.freeze({gm:f(step.gm*0.5),by:f(step.by*0.5),rc:f(step.rc*0.5),gmw:step.gmw,byw:step.byw,rcw:step.rcw,scale:f(1/sum),preserve:step.pl});
}
/** colorcontrast_slice8p (packed) and colorcontrast_slice8 (gbrp). Alpha and padding bytes are copied. Owned tight planes. */
export function colorcontrastVideoFrame(frame:VideoFrameData,step:ColorcontrastStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 for(const key of colorcontrastOptions){const value=step[key],[low,high]=ranges[key];if(typeof value!=='number'||!(value>=low&&value<=high)||Math.fround(value)!==value)throw new VideoColorcontrastError('Invalid colorcontrast settings');}
 if(!executable.includes(frame.pixelFormat))throw new VideoColorcontrastError('Colorcontrast pixel format is not supported');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoColorcontrastError('Colorcontrast frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoColorcontrastError('Invalid colorcontrast plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoColorcontrastError('Invalid colorcontrast plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoColorcontrastError('Colorcontrast input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoColorcontrastError('Invalid colorcontrast timestamp time base');
 const data=new Uint8Array(layout.bytes),{width,height}=frame,k=colorcontrastConstants(step),map=packed[frame.pixelFormat];
 for(const [index,plane]of layout.planes.entries()){const input=frame.planes[index]!,stride=frame.linesizes[index]!;for(let y=0;y<plane.height;y++)data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 if(k){
  if(map){
   const [ro,go,bo,pixel]=map,plane=layout.planes[0]!;
   for(let y=0;y<height;y++){
    signal?.throwIfAborted();const row=plane.offset+y*plane.rowBytes;
    for(let x=0;x<width;x++){
     if((x&4095)===0)signal?.throwIfAborted();
     const t=row+x*pixel,[r,g,b]=colorcontrastPixel(data[t+ro]!,data[t+go]!,data[t+bo]!,k);data[t+go]=g;data[t+bo]=b;data[t+ro]=r;
    }
   }
  }else{
   // gbrp: data[0] = G, data[1] = B, data[2] = R.
   const [gp,bp,rp]=layout.planes as unknown as readonly [typeof layout.planes[0],typeof layout.planes[0],typeof layout.planes[0]];
   for(let y=0;y<height;y++){
    signal?.throwIfAborted();const go=gp.offset+y*gp.rowBytes,bo=bp.offset+y*bp.rowBytes,ro=rp.offset+y*rp.rowBytes;
    for(let x=0;x<width;x++){
     if((x&4095)===0)signal?.throwIfAborted();
     const [r,g,b]=colorcontrastPixel(data[ro+x]!,data[go+x]!,data[bo+x]!,k);data[go+x]=g;data[bo+x]=b;data[ro+x]=r;
    }
   }
  }
 }
 return {width,height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const colorcontrastOperator=defineVideoOperator<ColorcontrastStep>({name:'colorcontrast',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['colorcontrast','format=gbrp,colorcontrast=rc=0.5:rcw=1','format=rgba,colorcontrast=-0.3:0.7:1:0.2:0.5:1:0.4','format=rgb24,colorcontrast=gm=-1:by=1:gmw=0.25:byw=0.75:pl=1,hflip'],
 parse:(token:FilterToken)=>singlePad(parseColorcontrastOptions(token.options)),
 formats:()=>colorcontrastPixelFormats,
 frame:(frame,step,options)=>colorcontrastVideoFrame(frame,step,options)});
