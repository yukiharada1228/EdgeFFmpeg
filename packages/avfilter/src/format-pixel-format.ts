// SPDX-License-Identifier: LGPL-2.1-or-later
// Fixed-reference format parsing follows libavfilter/vf_format.c and pixfmt.h
// at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
const names:Readonly<Record<string,string>>=Object.freeze({'0':'yuv420p','2':'rgb24','3':'bgr24','4':'yuv422p','5':'yuv444p','8':'gray','23':'nv12','24':'nv21','25':'argb','26':'rgba','27':'abgr','28':'bgra','33':'yuva420p','71':'gbrp'});
export class FormatPixelFormatError extends Error {}
/** The pinned references use LP64 strtol(base=0), then signed32 enum storage. */
function numericId(text:string):number {
 if(text==='')return 0;
 const digits=text.replace(/^[ \t\r\n\v\f]*/,'');let offset=0,negative=false;
 if(digits[offset]==='+'||digits[offset]==='-'){negative=digits[offset]==='-';offset++;}
 let base=10;
 if(digits[offset]==='0'){
  if(digits[offset+1]==='x'||digits[offset+1]==='X'){base=16;offset+=2;}
  else base=8;
 }
 if(offset===digits.length)throw new FormatPixelFormatError('Invalid numeric pixel format');
 const limit=negative?9223372036854775808n:9223372036854775807n,radix=BigInt(base);let value=0n,saturated=false;
 for(;offset<digits.length;offset++){
  const character=digits.charCodeAt(offset),digit=character>=48&&character<=57?character-48:character>=65&&character<=70?character-55:character>=97&&character<=102?character-87:-1;
  if(digit<0||digit>=base)throw new FormatPixelFormatError('Invalid numeric pixel format');
  if(!saturated){value=value*radix+BigInt(digit);if(value>limit){value=limit;saturated=true;}}
 }
 return Number(BigInt.asIntN(32,negative?-value:value));
}
/** Names/aliases already declared by pixelLayout, plus numeric IDs for those layouts. */
export function parseFilterPixelFormat(value:string):string {
 if(value.length>4096)throw new FormatPixelFormatError('Pixel format token exceeds limit');
 if(/^(gray8|y8)$/i.test(value))return 'gray';
 if(value==='rgb32')return 'bgra';if(value==='bgr32')return 'rgba';
 try{return pixelLayout(value,1,1).pixelFormat;}catch{/* Native next tries strtol, including an empty string. */}
 const name=names[String(numericId(value))];
 if(name===undefined)throw new FormatPixelFormatError('Pixel format is outside declared layouts');
 return name;
}
