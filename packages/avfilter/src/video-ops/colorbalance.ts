// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_colorbalance.c. See ../../NOTICE-COLORBALANCE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
import {filterBoolean} from './options.js';
export class VideoColorbalanceError extends Error {}
/** The nine AV_OPT_TYPE_FLOAT balances in AVOption order: shadows, midtones and highlights of red, green and blue. */
export const colorbalanceBalances=Object.freeze(['rs','gs','bs','rm','gm','bm','rh','gh','bh'] as const);
export type ColorbalanceBalance=typeof colorbalanceBalances[number];
/** balances holds the stored single-precision values in AVOption order; preserveLightness is pl. */
export type ColorbalanceStep={readonly name:'colorbalance';readonly balances:readonly number[];readonly preserveLightness:boolean};
/** The pinned pix_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const colorbalancePixelFormats:readonly string[]=Object.freeze('rgb24 bgr24 rgba bgra abgr argb 0bgr 0rgb rgb0 bgr0 rgb48le bgr48le rgba64le bgra64le gbrp gbrap gbrp9le gbrp10le gbrap10le gbrp12le gbrap12le gbrp14le gbrp16le gbrap16le'.split(' '));
/** The eight-bit members with frame storage here, in declared order: rgb24, bgr24, rgba, bgra, abgr, argb and gbrp. */
const executable:readonly string[]=Object.freeze(colorbalancePixelFormats.filter(executableFormat));
/** ff_fill_rgba_map byte offsets of R, G, B, A and the pixel step; gbrp is planar (G, B, R planes). */
const packed:Readonly<Record<string,readonly [number,number,number,number,number]>>={rgb24:[0,1,2,3,3],bgr24:[2,1,0,3,3],rgba:[0,1,2,3,4],bgra:[2,1,0,3,4],abgr:[3,2,1,0,4],argb:[1,2,3,0,4]};
const shorthand=[...colorbalanceBalances,'pl'];
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const f=Math.fround;
/** AV_OPT_TYPE_FLOAT from a constant decimal or set_string_number's default/max/min/none/all constants, range checked as a
 * double in -1..1, then stored as float. */
function floatOption(key:string,text:string):number{
 const named:Readonly<Record<string,number>>={default:0,max:1,min:-1,none:0,all:-1};
 const value=decimal.test(text)?Number(text):Object.hasOwn(named,text)?named[text]!:Number.NaN;
 if(Number.isNaN(value))throw new VideoFilterParseError(`Only constant decimal colorbalance ${key} values are implemented`);
 if(!(value>=-1&&value<=1))throw new VideoFilterParseError(`Invalid colorbalance ${key}: value outside -1..1`);
 return f(value);
}
/** colorbalance_options applied in order; later occurrences win. */
export function parseColorbalanceOptions(options:string|null):ColorbalanceStep{
 const balances=[0,0,0,0,0,0,0,0,0];let preserveLightness=false;
 for(const option of filterOptions(options,shorthand)){
  const index=(colorbalanceBalances as readonly string[]).indexOf(option.key);
  if(index>=0)balances[index]=floatOption(option.key,option.value);
  else if(option.key==='pl'){try{preserveLightness=filterBoolean(option.value);}catch(error){throw new VideoFilterParseError(`Invalid colorbalance pl: ${(error as Error).message}`);}}
  else if(option.key==='enable')throw new VideoFilterParseError('Colorbalance timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported colorbalance option');
 }
 return Object.freeze({name:'colorbalance',balances:Object.freeze(balances),preserveLightness});
}
/** av_clipf_c: FFMIN(FFMAX(a, amin), amax), so NaN becomes amin. */
const clip=(a:number,low:number,high:number)=>{const t=a>low?a:low;return t>high?high:t;};
const B=f(0.333),SCALE=f(0.7);
/** get_component in unfused single precision: every operation rounded with Math.fround. */
export function colorbalanceComponent(v:number,l:number,s:number,m:number,h:number):number{
 s=f(s*f(clip(f(f(f(B-l)*4)+0.5),0,1)*SCALE));
 m=f(m*f(f(clip(f(f(f(l-B)*4)+0.5),0,1)*clip(f(f(f(f(1-l)-B)*4)+0.5),0,1))*SCALE));
 h=f(h*f(clip(f(f(f(f(l+B)-1)*4)+0.5),0,1)*SCALE));
 v=f(v+s);v=f(v+m);v=f(v+h);
 return clip(v,0,1);
}
/** hfun; fmodf is exact, so the double remainder of a float is already a float. */
function hfun(n:number,h:number,s:number,l:number):number{
 const complement=f(1-l),a=f(s*(l>complement?complement:l)),k=f(n+f(h/30))%12,low=f(k-3),high=f(9-k),t0=low>high?high:low,t1=t0>1?1:t0,t=t1>-1?t1:-1;
 return clip(f(l-f(a*t)),0,1);
}
/** preservel: the HSL hue and saturation of the balanced components at the input lightness, with IEEE inf/NaN as native. */
export function colorbalancePreserve(r:number,g:number,b:number,l:number):readonly [number,number,number]{
 const m0=r>g?r:g,max=m0>b?m0:b,n0=r>g?g:r,min=n0>b?b:n0;let h:number,s:number;
 l=f(l*0.5);
 if(r===g&&g===b)h=0;
 else if(max===r)h=f(60*f(0+f(f(g-b)/f(max-min))));
 else if(max===g)h=f(60*f(2+f(f(b-r)/f(max-min))));
 else if(max===b)h=f(60*f(4+f(f(r-g)/f(max-min))));
 else h=0;
 if(h<0)h=f(h+360);
 if(max===1||min===0)s=0;else s=f(f(max-min)/f(1-Math.abs(f(f(2*l)-1))));
 return [hfun(0,h,s,l),hfun(8,h,s,l),hfun(4,h,s,l)];
}
/** lrintf under round-to-nearest-even, then av_clip_uint8; the argument is always a clipped 0..255 float. */
const toByte=(value:number)=>{const rounded=Math.round(value),even=rounded-value===0.5&&(rounded&1)!==0?rounded-1:rounded;return even<0?0:even>255?255:even;};
/** One pixel of color_balance8 / color_balance8_p: [r, g, b] bytes to balanced bytes. */
export function colorbalancePixel(step:ColorbalanceStep,red:number,green:number,blue:number):readonly [number,number,number]{
 const [rs,gs,bs,rm,gm,bm,rh,gh,bh]=step.balances as readonly [number,number,number,number,number,number,number,number,number];
 let r=f(red/255),g=f(green/255),b=f(blue/255);
 const m0=r>g?r:g,n0=r>g?g:r,l=f((m0>b?m0:b)+(n0>b?b:n0));
 r=colorbalanceComponent(r,l,rs,rm,rh);g=colorbalanceComponent(g,l,gs,gm,gh);b=colorbalanceComponent(b,l,bs,bm,bh);
 if(step.preserveLightness)[r,g,b]=colorbalancePreserve(r,g,b,l);
 return [toByte(f(r*255)),toByte(f(g*255)),toByte(f(b*255))];
}
/** color_balance8 (packed, alpha copied) and color_balance8_p (gbrp). Owned tight planes. */
export function balanceVideoColors(frame:VideoFrameData,step:ColorbalanceStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {balances}=step;
 if(!Array.isArray(balances)||balances.length!==9||balances.some(value=>typeof value!=='number'||!(value>=-1&&value<=1)||f(value)!==value)||typeof step.preserveLightness!=='boolean')throw new VideoColorbalanceError('Invalid colorbalance settings');
 if(!executable.includes(frame.pixelFormat))throw new VideoColorbalanceError('Colorbalance pixel format is not supported');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoColorbalanceError('Colorbalance frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoColorbalanceError('Invalid colorbalance plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoColorbalanceError('Invalid colorbalance plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoColorbalanceError('Colorbalance input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoColorbalanceError('Invalid colorbalance timestamp time base');
 const data=new Uint8Array(layout.bytes),{width,height}=frame,map=packed[frame.pixelFormat];
 if(map){
  const [ro,go,bo,ao,pixel]=map,alpha=pixel===4,plane=layout.planes[0]!,input=frame.planes[0]!,stride=frame.linesizes[0]!;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const source=y*stride,target=plane.offset+y*plane.rowBytes;
   for(let x=0;x<width;x++){
    if((x&4095)===0)signal?.throwIfAborted();
    const s=source+x*pixel,t=target+x*pixel,[r,g,b]=colorbalancePixel(step,input[s+ro]!,input[s+go]!,input[s+bo]!);
    data[t+ro]=r;data[t+go]=g;data[t+bo]=b;if(alpha)data[t+ao]=input[s+ao]!;
   }
  }
 }else{
  // gbrp: data[0] = G, data[1] = B, data[2] = R; there is no alpha plane.
  const [gp,bp,rp]=layout.planes as unknown as readonly [typeof layout.planes[0],typeof layout.planes[0],typeof layout.planes[0]];
  const [gi,bi,ri]=frame.planes as unknown as readonly [Uint8Array,Uint8Array,Uint8Array],[gs,bs,rs]=frame.linesizes as unknown as readonly [number,number,number];
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const gr=y*gs,br=y*bs,rr=y*rs,go=gp.offset+y*gp.rowBytes,bo=bp.offset+y*bp.rowBytes,ro=rp.offset+y*rp.rowBytes;
   for(let x=0;x<width;x++){
    if((x&4095)===0)signal?.throwIfAborted();
    const [r,g,b]=colorbalancePixel(step,ri[rr+x]!,gi[gr+x]!,bi[br+x]!);
    data[ro+x]=r;data[go+x]=g;data[bo+x]=b;
   }
  }
 }
 return {width,height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const colorbalanceOperator=defineVideoOperator<ColorbalanceStep>({name:'colorbalance',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['colorbalance','format=gbrp,colorbalance=rs=0.3:gm=-0.2:bh=0.5','format=rgba,colorbalance=-1:0.5:0:0.25:-0.75:1:0:0:-0.4:1,hflip','format=rgb24,colorbalance=rm=0.6:bs=-0.3:pl=1'],
 parse:(token:FilterToken)=>singlePad(parseColorbalanceOptions(token.options)),
 formats:()=>colorbalancePixelFormats,
 frame:(frame,step,options)=>balanceVideoColors(frame,step,options)});
