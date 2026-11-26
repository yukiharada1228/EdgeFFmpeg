// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_colorize.c. See ../../NOTICE-COLORIZE.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
export class VideoColorizeError extends Error {}
export type ColorizeStep={readonly name:'colorize';readonly hue:number;readonly saturation:number;readonly lightness:number;readonly mix:number};
/** The pinned pixel_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan
 * time by the shared negotiators. */
export const colorizePixelFormats:readonly string[]=Object.freeze('yuv410p yuv411p yuv420p yuv422p yuv440p yuv444p yuvj420p yuvj422p yuvj440p yuvj444p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv444p12le yuv422p12le yuv420p12le yuv440p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p yuva422p yuva444p yuva444p9le yuva444p10le yuva444p12le yuva444p16le yuva422p9le yuva422p10le yuva422p12le yuva422p16le yuva420p9le yuva420p10le yuva420p16le'.split(' '));
/** The eight-bit members with frame storage here (legacy yuvj names resolve to their planar storage). */
const executable:readonly string[]=Object.freeze(['yuv420p','yuv422p','yuv444p','yuva420p']);
const options=['hue','saturation','lightness','mix'] as const,ranges={hue:360,saturation:1,lightness:1,mix:1} as const;
const f=Math.fround,third=f(1/3),sixth=f(1/6),twoThirds=f(2/3);
/** hue2rgb with every float operation rounded, unfused as on the x86-64 baseline. */
function hue2rgb(p:number,q:number,t:number):number{
 if(t<0)t=f(t+1);
 if(t>1)t=f(t-1);
 if(t<sixth)return f(p+f(f(f(q-p)*6)*t));
 if(t<0.5)return q;
 if(t<twoThirds)return f(p+f(f(f(q-p)*f(twoThirds-t))*6));
 return p;
}
/** hsl2rgb then rgb2yuv at depth 8: float HSL, double YUV with C truncation to int. Returns the c[] triple of filter_frame. */
export function colorizeComponents(hue:number,saturation:number,lightness:number):readonly [number,number,number]{
 const h=f(f(hue)/360),s=f(saturation),l=f(lightness);let r:number,g:number,b:number;
 if(s===0)r=g=b=l;
 else{const q=l<0.5?f(l*f(1+s)):f(f(l+s)-f(l*s)),p=f(f(2*l)-q);r=hue2rgb(p,q,f(h+third));g=hue2rgb(p,q,h);b=hue2rgb(p,q,f(h-third));}
 const max=255;
 return [((0.21260*219.0/255.0)*r+(0.71520*219.0/255.0)*g+(0.07220*219.0/255.0)*b)*max|0,(-(0.11457*224.0/255.0)*r-(0.38543*224.0/255.0)*g+(0.50000*224.0/255.0)*b+0.5)*max|0,((0.50000*224.0/255.0)*r-(0.45415*224.0/255.0)*g-(0.04585*224.0/255.0)*b+0.5)*max|0];
}
/** AV_OPT_TYPE_FLOAT: the double is range-checked against the declared bounds, then stored as float. Expressions, constants and SI
 * suffixes are not implemented. Options apply in order, so a repeated key keeps its last value. */
export function parseColorizeOptions(text:string|null):ColorizeStep{
 const values={hue:0,saturation:f(0.5),lightness:f(0.5),mix:1};
 for(const option of filterOptions(text,options)){
  if((options as readonly string[]).includes(option.key)){
   const key=option.key as typeof options[number];
   if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(option.value))throw new VideoFilterParseError(`Only decimal colorize ${key} values are implemented`);
   const value=Number(option.value);if(!(value>=0&&value<=ranges[key]))throw new VideoFilterParseError(`colorize ${key} must be within [0,${ranges[key]}]`);
   values[key]=f(value);
  }else if(option.key==='enable')throw new VideoFilterParseError('Colorize timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported colorize option');
 }
 return Object.freeze({name:'colorize',...values});
}
/** filter_frame on a writable copy: colorizey_slice8 lerps luma towards c[0], colorize_slice8 fills both chroma planes, alpha is copied.
 * Owned tight planes. */
export function colorizeVideoFrame(frame:VideoFrameData,step:ColorizeStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {hue,saturation,lightness,mix}=step;
 if(![hue,saturation,lightness,mix].every(value=>typeof value==='number'&&Object.is(f(value),value)&&value>=0)||hue>360||saturation>1||lightness>1||mix>1)throw new VideoColorizeError('Invalid colorize settings');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);if(!executable.includes(layout.pixelFormat))throw new VideoColorizeError('Colorize pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoColorizeError('Colorize frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoColorizeError('Invalid colorize plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoColorizeError('Invalid colorize plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoColorizeError('Colorize input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoColorizeError('Invalid colorize timestamp time base');
 const [yv,u,v]=colorizeComponents(hue,saturation,lightness),data=new Uint8Array(layout.bytes),luma=layout.planes[0]!,source=frame.planes[0]!,lumaStride=frame.linesizes[0]!;
 // lerpf(yv, yptr[x], mix) in float, stored through the uint8_t conversion.
 for(let y=0;y<luma.height;y++){
  signal?.throwIfAborted();const row=y*lumaStride,target=luma.offset+y*luma.rowBytes;
  for(let x=0;x<luma.rowBytes;x++){if((x&16383)===0)signal?.throwIfAborted();data[target+x]=f(yv+f(f(source[row+x]!-yv)*mix));}
 }
 // Both chroma planes share planewidth[1] and planeheight[1].
 data.fill(u,layout.planes[1]!.offset,layout.planes[1]!.offset+layout.planes[1]!.bytes);data.fill(v,layout.planes[2]!.offset,layout.planes[2]!.offset+layout.planes[2]!.bytes);
 for(const plane of layout.planes.slice(3)){
  const input=frame.planes[3]!,stride=frame.linesizes[3]!;
  for(let y=0;y<plane.height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const colorizeOperator=defineVideoOperator<ColorizeStep>({name:'colorize',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuv420p,colorize','format=yuv444p,colorize=hue=120:saturation=1:lightness=0.25,hflip','format=yuv422p,colorize=0:0:0:0','format=yuva420p,colorize=300:0.75:0.6:0.3,vflip'],
 parse:(token:FilterToken)=>singlePad(parseColorizeOptions(token.options)),
 formats:()=>colorizePixelFormats,
 frame:(frame,step,options)=>colorizeVideoFrame(frame,step,options)});
