// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_floodfill.c. See ../../NOTICE-FLOODFILL.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export type FloodfillComponents=readonly [number,number,number,number];
export type FloodfillStep={readonly name:'floodfill';readonly x:number;readonly y:number;readonly source:FloodfillComponents;readonly destination:FloodfillComponents};
/** The pinned pixel_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const floodfillPixelFormats:readonly string[]=Object.freeze('gray gray9le gray10le gray14le gray16le yuv444p yuva444p gbrp gbrp9le gbrp10le gbrap10le gbrp12le gbrap12le gbrp14le gbrp16le gbrap16le gbrap yuv444p9le yuva444p9le yuv444p10le yuva444p10le yuv444p12le yuv444p14le yuv444p16le yuva444p16le'.split(' '));
/** The eight-bit members with frame storage here: gray, yuv444p and gbrp. */
const executable:readonly string[]=Object.freeze(floodfillPixelFormats.filter(executableFormat));
if(executable.join(' ')!=='gray yuv444p gbrp')throw new Error('Floodfill layouts must be the executable native formats');
const coordinate={min:0,max:65535,defaultValue:0},sourceRange={min:-1,max:65535,defaultValue:0},destinationRange={min:0,max:65535,defaultValue:0};
const names=['x','y','s0','s1','s2','s3','d0','d1','d2','d3'] as const;
/** AV_OPT_TYPE_INT options in floodfill_options order, applied in order; later occurrences win. */
export function parseFloodfillOptions(options:string|null):FloodfillStep{
 const values=[0,0,0,0,0,0,0,0,0,0];
 for(const option of filterOptions(options,names)){
  const index=(names as readonly string[]).indexOf(option.key);
  if(index<0){if(option.key==='enable')throw new VideoFilterParseError('Floodfill timeline expressions are not implemented');throw new VideoFilterParseError('Unsupported floodfill option');}
  try{values[index]=filterIntegerOption(option.value,index<2?coordinate:index<6?sourceRange:destinationRange);}catch(error){throw new VideoFilterParseError(`Invalid floodfill ${option.key}: ${(error as Error).message}`);}
 }
 const [x,y,s0,s1,s2,s3,d0,d1,d2,d3]=values as [number,number,number,number,number,number,number,number,number,number];
 return Object.freeze({name:'floodfill',x,y,source:Object.freeze([s0,s1,s2,s3] as const),destination:Object.freeze([d0,d1,d2,d3] as const)});
}
const checkStep=(step:FloodfillStep)=>{
 const ok=(value:unknown,min:number)=>Number.isInteger(value)&&(value as number)>=min&&(value as number)<=65535;
 if(!ok(step.x,0)||!ok(step.y,0)||!Array.isArray(step.source)||step.source.length!==4||!Array.isArray(step.destination)||step.destination.length!==4||!step.source.every(value=>ok(value,-1))||!step.destination.every(value=>ok(value,0)))throw new Error('Invalid floodfill settings');
};
/** filter_frame refuses frames wider or taller than UINT16_MAX + 1 (its Points are uint16). */
export function checkFloodfillSize(width:number,height:number):void{if(width>65536||height>65536)throw new Error('Floodfill frames wider or taller than 65536 are not supported');}
/** filter_frame with config_input's eight-bit is_same/set_pixel/pick_pixel: the seed's 4-connected region matching s0..s3 on every
 * plane becomes d0..d3 (stored modulo 256). The point stack pops in native order; pushes of neighbours that do not match are
 * skipped, which leaves the sequence of set_pixel calls unchanged because a pixel that does not match never matches later. The stack
 * holds 32-bit pixel indices and is bounded by maxFrameBytes. Owned tight planes; the input is never mutated. */
export function floodfillVideoFrame(frame:VideoFrameData,step:FloodfillStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();checkStep(step);
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);if(!executable.includes(layout.pixelFormat))throw new Error('Floodfill pixel format is not supported');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new Error('Floodfill frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Invalid floodfill plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid floodfill plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new Error('Floodfill input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid floodfill timestamp time base');
 const w=frame.width,h=frame.height;checkFloodfillSize(w,h);
 const data=new Uint8Array(layout.bytes),count=layout.planes.length;
 for(const [index,plane]of layout.planes.entries()){const input=frame.planes[index]!,stride=frame.linesizes[index]!;for(let y=0;y<plane.height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}}
 const planes=layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),output={width:w,height:h,pixelFormat:layout.pixelFormat,planes,linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
 const {x:sx,y:sy}=step;if(sx>=w||sy>=h)return output;
 // pick_pixel replaces negative sources on the frame's planes; the end check compares the picked sources with d on those planes.
 const seed=sy*w+sx,s=step.source.map((value,index)=>index<count&&value<0?planes[index]![seed]!:value),d=step.destination;
 if(s.slice(0,count).every((value,index)=>value===d[index]))return output;
 const same=(at:number)=>{for(let index=0;index<count;index++)if(planes[index]![at]!==s[index])return false;return true;};
 if(!same(seed))return output;
 const stored=d.map(value=>value&255);
 // Eight-bit set_pixel truncates d: when the stored values still match, a lone seed is rewritten with its own values, and any larger
 // region makes native's loop re-push its pixels forever until it overruns its point buffer.
 if(stored.slice(0,count).every((value,index)=>value===s[index])){
  if(!(sx+1<w&&same(seed+1))&&!(sx>0&&same(seed-1))&&!(sy+1<h&&same(seed+w))&&!(sy>0&&same(seed-w)))return output;
  throw new Error('Floodfill destination matches its source after eight-bit truncation; native never terminates');
 }
 const limit=Math.floor(maxFrameBytes/4);let stack=new Uint32Array(Math.min(64,limit)),front=0,steps=0;
 const push=(at:number)=>{if(!same(at))return;if(front===stack.length){if(front>=limit)throw new Error('Floodfill point stack exceeds allocation limit');const grown=new Uint32Array(Math.min(limit,stack.length*2));grown.set(stack);stack=grown;}stack[front++]=at;};
 push(seed);
 while(front>0){
  if((++steps&16383)===0)signal?.throwIfAborted();
  const at=stack[--front]!;if(!same(at))continue;
  for(let index=0;index<count;index++)planes[index]![at]=stored[index]!;
  const x=at%w,y=(at-x)/w;
  if(x+1<w)push(at+1);if(x>0)push(at-1);if(y+1<h)push(at+w);if(y>0)push(at-w);
 }
 return output;
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const floodfillOperator=defineVideoOperator<FloodfillStep>({name:'floodfill',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['floodfill','floodfill=x=3:y=2:s0=-1:d0=200','floodfill=0:0:-1:-1:-1:-1:9:8:7,hflip','format=gbrp,floodfill=x=1:s0=-1:s1=-1:s2=-1:d0=1:d1=2:d2=3','floodfill=x=9:y=0:s0=-1:d0=5','format=yuv444p,floodfill=s0=-1:s1=-1:s2=-1:d0=10:d1=20:d2=30,vflip'],
 parse:(token:FilterToken)=>singlePad(parseFloodfillOptions(token.options)),
 formats:()=>floodfillPixelFormats,
 geometry(_step,[input]){if(!input)throw new Error('Floodfill needs one input');checkFloodfillSize(input.width,input.height);return {width:input.width,height:input.height};},
 frame:(frame,step,options)=>floodfillVideoFrame(frame,step,options)});
