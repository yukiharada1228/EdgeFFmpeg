// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_vibrance.c. See ../../NOTICE-VIBRANCE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
import {filterBoolean} from './options.js';
export class VideoVibranceError extends Error {}
/** AV_OPT_TYPE_FLOAT values as stored (Math.fround of the parsed double); balance and lcoeffs keep native's G, B, R slot order. */
export type VibranceStep={readonly name:'vibrance';readonly intensity:number;readonly rbal:number;readonly gbal:number;readonly bbal:number;readonly rlum:number;readonly glum:number;readonly blum:number;readonly alternate:boolean};
/** The pinned pixel_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const vibrancePixelFormats:readonly string[]=Object.freeze('rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0 gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le rgb48le bgr48le rgba64le bgra64le'.split(' '));
/** The eight-bit members with frame storage here: rgb24, bgr24, rgba, bgra, argb, abgr and gbrp. */
const executable:readonly string[]=Object.freeze(vibrancePixelFormats.filter(executableFormat));
/** ff_fill_rgba_map byte offsets of R, G, B, A and the pixel step (nb_components); gbrp is planar (G, B, R planes). */
const packed:Readonly<Record<string,readonly [number,number,number,number,number]>>={rgb24:[0,1,2,3,3],bgr24:[2,1,0,3,3],rgba:[0,1,2,3,4],bgra:[2,1,0,3,4],argb:[1,2,3,0,4],abgr:[3,2,1,0,4]};
const keys=['intensity','rbal','gbal','bbal','rlum','glum','blum'] as const;
type FloatKey=typeof keys[number];
/** vibrance_options: AVOption order, ranges and defaults. */
const ranges:Readonly<Record<FloatKey,readonly [number,number,number]>>={intensity:[-2,2,0],rbal:[-10,10,1],gbal:[-10,10,1],bbal:[-10,10,1],rlum:[0,1,0.212656],glum:[0,1,0.715158],blum:[0,1,0.072186]};
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** AV_OPT_TYPE_FLOAT: a constant decimal or one of set_string_number's default/max/min/none/all constants, range checked as a double, stored as float. */
function floatOption(key:FloatKey,text:string):number{
 const [low,high,fallback]=ranges[key],named:Readonly<Record<string,number>>={default:fallback,max:high,min:low,none:0,all:-1};
 const value=decimal.test(text)?Number(text):Object.hasOwn(named,text)?named[text]!:Number.NaN;
 if(Number.isNaN(value))throw new VideoFilterParseError(`Only constant decimal vibrance ${key} values are implemented`);
 if(!(value>=low&&value<=high))throw new VideoFilterParseError(`Invalid vibrance ${key}: value outside ${low}..${high}`);
 return Math.fround(value);
}
/** vibrance_options applied in order; enable= and every other option are refused. */
export function parseVibranceOptions(options:string|null):VibranceStep{
 const values:Record<FloatKey,number>={intensity:0,rbal:1,gbal:1,bbal:1,rlum:Math.fround(0.212656),glum:Math.fround(0.715158),blum:Math.fround(0.072186)};let alternate=false;
 for(const option of filterOptions(options,[...keys,'alternate'])){
  if((keys as readonly string[]).includes(option.key))values[option.key as FloatKey]=floatOption(option.key as FloatKey,option.value);
  else if(option.key==='alternate'){
   // set_string_bool: auto is -1, outside 0..1.
   if(option.value==='auto')throw new VideoFilterParseError('Invalid vibrance alternate: value outside 0..1');
   try{alternate=filterBoolean(option.value);}catch(error){throw new VideoFilterParseError(`Invalid vibrance alternate: ${(error as Error).message}`);}
  }else if(option.key==='enable')throw new VideoFilterParseError('Vibrance timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported vibrance option');
 }
 return Object.freeze({name:'vibrance',...values,alternate});
}
const f=Math.fround,scale=f(1/255);
/** av_clip_uint8 of the float-to-int conversion (truncation toward zero). */
const clip=(value:number)=>{const n=Math.trunc(value);return n<0?0:n>255?255:n;};
/** vibrance_slice8 and vibrance_slice8p in single precision, every operation rounded with Math.fround and nothing fused;
 * the alpha byte is copied. Owned tight planes. */
export function vibranceVideoFrame(frame:VideoFrameData,step:VibranceStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 for(const key of keys){const value=step[key],[low,high]=ranges[key];if(typeof value!=='number'||!(value>=low&&value<=high)||f(value)!==value)throw new VideoVibranceError('Invalid vibrance settings');}
 if(typeof step.alternate!=='boolean')throw new VideoVibranceError('Invalid vibrance settings');
 if(!executable.includes(frame.pixelFormat))throw new VideoVibranceError('Vibrance pixel format is not supported');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoVibranceError('Vibrance frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoVibranceError('Invalid vibrance plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoVibranceError('Invalid vibrance plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoVibranceError('Vibrance input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoVibranceError('Invalid vibrance timestamp time base');
 const {intensity}=step,gc=step.glum,bc=step.blum,rc=step.rlum,alternate=step.alternate?1:-1;
 const gi=f(intensity*step.gbal),bi=f(intensity*step.bbal),ri=f(intensity*step.rbal);
 // FFSIGN(x) is 1 for x > 0 and -1 otherwise (zero included).
 const sg=alternate*(gi>0?1:-1),sb=alternate*(bi>0?1:-1),sr=alternate*(ri>0?1:-1);
 const data=new Uint8Array(layout.bytes),{width,height}=frame,map=packed[frame.pixelFormat],out=[0,0,0];
 const pixel=(gv:number,bv:number,rv:number)=>{
  const g=f(gv*scale),b=f(bv*scale),r=f(rv*scale),max=Math.max(r,g,b),min=Math.min(r,g,b),saturation=f(max-min);
  const luma=f(f(f(g*gc)+f(r*rc))+f(b*bc));
  const cg=f(1+f(gi*f(1-f(sg*saturation)))),cb=f(1+f(bi*f(1-f(sb*saturation)))),cr=f(1+f(ri*f(1-f(sr*saturation))));
  // lerpf(v0, v1, t) = v0 + (v1 - v0) * t.
  out[0]=clip(f(f(luma+f(f(g-luma)*cg))*255));out[1]=clip(f(f(luma+f(f(b-luma)*cb))*255));out[2]=clip(f(f(luma+f(f(r-luma)*cr))*255));
 };
 if(map){
  const [ro,go,bo,ao,size]=map,alpha=size===4,plane=layout.planes[0]!,input=frame.planes[0]!,stride=frame.linesizes[0]!;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const source=y*stride,target=plane.offset+y*plane.rowBytes;
   for(let x=0;x<width;x++){
    if((x&4095)===0)signal?.throwIfAborted();
    const s=source+x*size,t=target+x*size;pixel(input[s+go]!,input[s+bo]!,input[s+ro]!);
    data[t+go]=out[0]!;data[t+bo]=out[1]!;data[t+ro]=out[2]!;if(alpha)data[t+ao]=input[s+ao]!;
   }
  }
 }else{
  // gbrp: data[0] = G, data[1] = B, data[2] = R; no alpha plane.
  const [gp,bp,rp]=layout.planes as unknown as readonly [typeof layout.planes[0],typeof layout.planes[0],typeof layout.planes[0]];
  const [gin,bin,rin]=frame.planes as unknown as readonly [Uint8Array,Uint8Array,Uint8Array],[gs,bs,rs]=frame.linesizes as unknown as readonly [number,number,number];
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const gr=y*gs,br=y*bs,rr=y*rs,go=gp.offset+y*gp.rowBytes,bo=bp.offset+y*bp.rowBytes,ro=rp.offset+y*rp.rowBytes;
   for(let x=0;x<width;x++){
    if((x&4095)===0)signal?.throwIfAborted();
    pixel(gin[gr+x]!,bin[br+x]!,rin[rr+x]!);data[go+x]=out[0]!;data[bo+x]=out[1]!;data[ro+x]=out[2]!;
   }
  }
 }
 return {width,height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const vibranceOperator=defineVideoOperator<VibranceStep>({name:'vibrance',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['vibrance','format=gbrp,vibrance=intensity=0.5','format=rgba,vibrance=1:2:-1:0.5:0.3:0.6:0.1:1','format=bgr24,vibrance=intensity=-1.5:gbal=10,hflip'],
 parse:(token:FilterToken)=>singlePad(parseVibranceOptions(token.options)),
 formats:()=>vibrancePixelFormats,
 frame:(frame,step,options)=>vibranceVideoFrame(frame,step,options)});
