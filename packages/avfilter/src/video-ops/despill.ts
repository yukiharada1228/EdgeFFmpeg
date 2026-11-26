// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_despill.c and libavutil/opt.c. See ../../NOTICE-DESPILL.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
/** type 0 is greenscreen and 1 bluescreen; every float is the stored single-precision value. */
export type DespillStep={readonly name:'despill';readonly type:0|1;readonly mix:number;readonly expand:number;readonly red:number;readonly green:number;readonly blue:number;readonly brightness:number;readonly alpha:boolean};
/** The pinned pixel_fmts in declared order; all four have packed frame storage here. */
export const despillPixelFormats:readonly string[]=Object.freeze(['argb','rgba','abgr','bgra']);
/** config_output's comp[i].offset for R, G, B, A. */
const offsets:Readonly<Record<string,readonly [number,number,number,number]>>={argb:[1,2,3,0],rgba:[0,1,2,3],abgr:[3,2,1,0],bgra:[2,1,0,3]};
/** AVOption order; the type constants green and blue are skipped by shorthand. */
const shorthand=['type','mix','expand','red','green','blue','brightness','alpha'] as const;
const floats={mix:[0,1],expand:[0,1],red:[-100,100],green:[-100,100],blue:[-100,100],brightness:[-10,10]} as const;
/** AV_OPT_TYPE_FLOAT: the double is range-checked, then stored as float. Expressions and suffixes are not implemented. */
function floatValue(key:keyof typeof floats,text:string):number{
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new VideoFilterParseError(`Only decimal despill ${key} values are implemented`);
 const value=Number(text),[min,max]=floats[key];if(!(value>=min&&value<=max))throw new VideoFilterParseError(`Despill ${key} ${text} is outside [${min} - ${max}]`);return Math.fround(value);
}
/** AV_OPT_TYPE_BOOL: set_string_bool's names (case-insensitive) or a strtol integer in [0,1]; auto (-1) is out of range. */
function boolValue(text:string):boolean{
 const lower=text.toLowerCase();
 if(['true','y','yes','enable','enabled','on'].includes(lower))return true;
 if(['false','n','no','disable','disabled','off'].includes(lower))return false;
 if(/^[+-]?\d+$/.test(text)){const value=Number(text);if(value===0||value===1)return value===1;}
 throw new VideoFilterParseError('Only despill alpha values 0, 1 and boolean names are implemented');
}
/** Options applied in order; repeated keys keep the last value. */
export function parseDespillOptions(options:string|null):DespillStep{
 const values={type:0 as 0|1,mix:Math.fround(0.5),expand:0,red:0,green:-1,blue:0,brightness:0,alpha:false};
 for(const option of filterOptions(options,shorthand)){
  const key=option.key;
  if(key==='type'){let value;try{value=filterIntegerOption(option.value,{min:0,max:1,defaultValue:0,constants:{green:0,blue:1}});}catch(error){throw new VideoFilterParseError(`Invalid despill type: ${(error as Error).message}`);}values.type=value===1?1:0;}
  else if(key==='mix'||key==='expand'||key==='red'||key==='green'||key==='blue'||key==='brightness')values[key]=floatValue(key,option.value);
  else if(key==='alpha')values.alpha=boolValue(option.value);
  else if(key==='enable')throw new VideoFilterParseError('Despill timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported despill option');
 }
 return Object.freeze({name:'despill',...values});
}
const checkStep=(step:DespillStep)=>{
 const inRange=(value:number,min:number,max:number)=>typeof value==='number'&&value>=min&&value<=max&&Math.fround(value)===value;
 if((step.type!==0&&step.type!==1)||typeof step.alpha!=='boolean'||!(Object.keys(floats) as (keyof typeof floats)[]).every(key=>inRange(step[key],floats[key][0],floats[key][1])))throw new Error('Invalid despill settings');
};
/** av_clip_uint8 of the C float-to-int conversion (truncation); every operand is finite and nonnegative here. */
const clip=(value:number)=>{const n=Math.trunc(value);return n<0?0:n>255?255:n;};
/** filter_frame and do_despill_slice on a writable copy: every float operation is rounded to single precision, unfused. Owned tight plane. */
export function despillVideoFrame(frame:VideoFrameData,step:DespillStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),co=offsets[layout.pixelFormat];if(!co)throw new Error('Despill pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new Error('Despill frame exceeds allocation limit');
 if(frame.planes.length!==1||frame.linesizes.length!==1||layout.planes.length!==1)throw new Error('Invalid despill plane count');
 const plane=layout.planes[0]!,input=frame.planes[0],stride=frame.linesizes[0];
 if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid despill plane stride or storage');
 if(input.length>maxFrameBytes)throw new Error('Despill input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid despill timestamp time base');
 const f=Math.fround,[ro,go,bo,ao]=co,{type,alpha}=step,mix=step.mix,redscale=step.red,greenscale=step.green,bluescale=step.blue,brightness=step.brightness;
 const factor=f(f(1-mix)*f(1-step.expand)),data=new Uint8Array(layout.bytes),width=frame.width;
 for(let y=0;y<plane.height;y++){
  signal?.throwIfAborted();const row=y*plane.rowBytes;data.set(input.subarray(y*stride!,y*stride!+plane.rowBytes),row);
  for(let x=0;x<width;x++){
   if((x&4095)===4095)signal?.throwIfAborted();
   const p=row+x*4;let red=f(data[p+ro]!/255),green=f(data[p+go]!/255),blue=f(data[p+bo]!/255);
   let spillmap=type?f(blue-f(f(red*mix)+f(green*factor))):f(green-f(f(red*mix)+f(blue*factor)));if(!(spillmap>0))spillmap=0;
   const bright=f(brightness*spillmap);
   red=f(f(red+f(spillmap*redscale))+bright);if(!(red>0))red=0;
   green=f(f(green+f(spillmap*greenscale))+bright);if(!(green>0))green=0;
   blue=f(f(blue+f(spillmap*bluescale))+bright);if(!(blue>0))blue=0;
   data[p+ro]=clip(f(red*255));data[p+go]=clip(f(green*255));data[p+bo]=clip(f(blue*255));
   if(alpha)data[p+ao]=clip(f(f(1-spillmap)*255));
  }
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:[data],linesizes:[plane.rowBytes],pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const despillOperator=defineVideoOperator<DespillStep>({name:'despill',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=rgba,despill','format=argb,despill=blue:0.25:0.5,hflip','format=bgra,despill=type=green:red=0.5:green=-2:brightness=1:alpha=1','format=abgr,despill=mix=0:expand=1:blue=3'],
 parse:(token:FilterToken)=>singlePad(parseDespillOptions(token.options)),
 formats:()=>despillPixelFormats,
 frame:(frame,step,options)=>despillVideoFrame(frame,step,options)});
