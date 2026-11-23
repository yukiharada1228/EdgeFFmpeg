// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped option semantics adapted from pinned FFmpeg avfilter.c and vf_scale.c. See ../NOTICE.
import {parseVideoSize} from '@edge-ffmpeg/avutil';
import {parseFilterPixelFormat} from './format-pixel-format.js';
import {filterOptions} from './video-syntax.js';
import type {LinearFilterToken} from './video-syntax.js';
export type ParsedVideoStep={readonly name:'transpose';readonly direction:number;readonly passthrough:number}|{readonly name:'null'|'hflip'|'vflip'}|{readonly name:'format';readonly pixelFormat:string|null;readonly pixelFormats:readonly string[]|null}|{readonly name:'scale';readonly width:number|null;readonly height:number|null};
export class VideoFilterParseError extends Error {}
const dimension=(value:string):number=>{
 const text=value.replace(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/g,'');
 if(!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)<1||Number(text)>2147483647)throw new VideoFilterParseError('Only positive constant scale dimensions are implemented');return Number(text);
};
export function parseVideoFilterToken(filter:LinearFilterToken):ParsedVideoStep {
  if(filter.name==='null'||filter.name==='hflip'||filter.name==='vflip'){
   if(filterOptions(filter.options,[]).length)throw new VideoFilterParseError('Timeline and reflection options are not implemented');return Object.freeze({name:filter.name});
  }
  if(filter.name==='transpose'){
   let direction=0,passthrough=0;
   const directions:Record<string,number>={cclock_flip:0,clock:1,cclock:2,clock_flip:3},modes:Record<string,number>={none:0,landscape:1,portrait:2};
   for(const option of filterOptions(filter.options,['dir','passthrough'])){
    const names=option.key==='dir'?directions:option.key==='passthrough'?modes:null;
    if(!names)throw new VideoFilterParseError('Unsupported transpose option');
    const value=Object.hasOwn(names,option.value)?names[option.value]!: /^\d+$/.test(option.value)?Number(option.value):NaN;
    if(!Number.isSafeInteger(value)||value<0||value>(option.key==='dir'?7:2147483647))throw new VideoFilterParseError('Only declared transpose constants and nonnegative decimal integers are implemented');
    if(option.key==='dir')direction=value;else passthrough=value;
   }
   if(direction&4){direction&=3;passthrough=1;}
   return Object.freeze({name:'transpose',direction,passthrough});
  }
  if(filter.name==='format'){
   let value:string|null=null;
   for(const option of filterOptions(filter.options,['pix_fmts','color_spaces','color_ranges','alpha_modes'])){
    if(option.key!=='pix_fmts')throw new VideoFilterParseError('Color options are not implemented');value=option.value;
   }
   if(value===null)return Object.freeze({name:'format',pixelFormat:null,pixelFormats:null});
   const candidates=value.split('|').map(parseFilterPixelFormat);
   if(new Set(candidates).size!==candidates.length)throw new VideoFilterParseError('Duplicated pixel format');
   const pixelFormats=Object.freeze(candidates);return Object.freeze({name:'format',pixelFormat:pixelFormats.length===1?pixelFormats[0]!:null,pixelFormats});
  }
  if(filter.name!=='scale')throw new VideoFilterParseError('Unsupported video filter');
  let width:string|undefined,height:string|undefined,size:string|undefined,flags:string|undefined;
  for(const option of filterOptions(filter.options,['w','h','flags','interl','size'])){
   if(option.key==='w'||option.key==='width')width=option.value;
   else if(option.key==='h'||option.key==='height')height=option.value;
   else if(option.key==='size'||option.key==='s')size=option.value;
   else if(option.key==='flags')flags=option.value;
   else throw new VideoFilterParseError('Unsupported scale option');
  }
  if(flags!==undefined&&flags!==''&&flags!=='bicubic')throw new VideoFilterParseError('Only default bicubic flags are implemented');
  if(size!==undefined&&(width!==undefined||height!==undefined))throw new VideoFilterParseError('Size and scale expressions cannot be combined');
  if(width!==undefined&&height===undefined){size=width;width=undefined;}
  if(size!==undefined){const parsed=parseVideoSize(size);return Object.freeze({name:'scale',...parsed});}
  return Object.freeze({name:'scale',width:width===undefined?null:dimension(width),height:height===undefined?null:dimension(height)});

}
