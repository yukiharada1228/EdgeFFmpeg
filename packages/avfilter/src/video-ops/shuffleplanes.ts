// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_shuffleplanes.c. See ../../NOTICE-SHUFFLEPLANES.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {negotiableFormats,executableFormat} from './formats.js';
export type ShuffleplanesMap=readonly [number,number,number,number];
export type ShuffleplanesStep={readonly name:'shuffleplanes';readonly map:ShuffleplanesMap};
export class VideoShuffleplanesError extends Error {}
/** av_pix_fmt_count_planes and chroma subsampling (log2_chroma_w|log2_chroma_h, suffix s) of the pinned build's pixel formats
 * with more than one plane or with subsampling; every other non-palette format has one plane and no subsampling. */
const classes:Readonly<Record<string,string>>={
 '1s':'yuyv422 uyvy422 uyyvyy411 yvyu422 y210be y210le y212be y212le y216be y216le',
 '2':'nv24 nv42 p410be p410le p416be p416le p412be p412le',
 '2s':'nv12 nv21 nv16 nv20le nv20be p010le p010be p016le p016be p210be p210le p216be p216le p012le p012be p212be p212le',
 '3':'yuv444p yuvj444p yuv444p16le yuv444p16be yuv444p9be yuv444p9le yuv444p10be yuv444p10le gbrp gbrp9be gbrp9le gbrp10be gbrp10le gbrp16be gbrp16le yuv444p12be yuv444p12le yuv444p14be yuv444p14le gbrp12be gbrp12le gbrp14be gbrp14le gbrpf32be gbrpf32le gbrpf16be gbrpf16le yuv444p10msbbe yuv444p10msble yuv444p12msbbe yuv444p12msble gbrp10msbbe gbrp10msble gbrp12msbbe gbrp12msble',
 '3s':'yuv420p yuv422p yuv410p yuv411p yuvj420p yuvj422p yuv440p yuvj440p yuv420p16le yuv420p16be yuv422p16le yuv422p16be yuv420p9be yuv420p9le yuv420p10be yuv420p10le yuv422p10be yuv422p10le yuv422p9be yuv422p9le yuv420p12be yuv420p12le yuv420p14be yuv420p14le yuv422p12be yuv422p12le yuv422p14be yuv422p14le yuvj411p yuv440p10le yuv440p10be yuv440p12le yuv440p12be',
 '4':'yuva444p yuva444p9be yuva444p9le yuva444p10be yuva444p10le yuva444p16be yuva444p16le gbrap gbrap16be gbrap16le gbrap12be gbrap12le gbrap10be gbrap10le gbrapf32be gbrapf32le yuva444p12be yuva444p12le gbrap14be gbrap14le gbrapf16be gbrapf16le gbrap32be gbrap32le',
 '4s':'yuva420p yuva422p yuva420p9be yuva420p9le yuva422p9be yuva422p9le yuva420p10be yuva420p10le yuva422p10be yuva422p10le yuva420p16be yuva420p16le yuva422p16be yuva422p16le yuva422p12be yuva422p12le',
};
const traits=new Map<string,readonly [number,boolean]>();
for(const [key,names]of Object.entries(classes))for(const name of names.split(' '))traits.set(name,[Number(key[0]),key.endsWith('s')]);
/** query_formats over every AVPixelFormat except palettes, in AVPixelFormat order: every map[i] below the plane count; subsampled
 * formats keep planes 1 and 2 within {1,2}. A negotiated format outside the executable table is refused at plan time. */
const lists=new Map<number,readonly string[]>();
export function shuffleplanesFormats(map:ShuffleplanesMap):readonly string[]{
 const code=map[0]|map[1]<<2|map[2]<<4|map[3]<<6;let list=lists.get(code);
 if(!list){list=Object.freeze(negotiableFormats.filter(format=>{if(format==='pal8')return false;const [planes,subsampled]=traits.get(format)??[1,false];return map.every((value,i)=>value<planes&&(!subsampled||(i===1||i===2)===(value===1||value===2)));}));lists.set(code,list);}
 return list;
}
/** The mapping's members with frame storage here. */
const runs=(map:ShuffleplanesMap,format:string)=>executableFormat(format)&&shuffleplanesFormats(map).includes(format);
const parse=(token:{readonly options:string|null})=>{
 const map=[0,1,2,3];
 for(const option of filterOptions(token.options,['map0','map1','map2','map3'])){
  if(option.key==='enable')throw new VideoFilterParseError('Shuffleplanes timeline expressions are not implemented');
  const index=['map0','map1','map2','map3'].indexOf(option.key);if(index<0)throw new VideoFilterParseError('Unsupported shuffleplanes option');
  if(!/^[0-3]$/.test(option.value))throw new VideoFilterParseError('Only decimal shuffleplanes plane indices 0 to 3 are implemented');
  map[index]=Number(option.value);
 }
 const step:ShuffleplanesStep=Object.freeze({name:'shuffleplanes',map:Object.freeze(map) as unknown as ShuffleplanesMap});
 if(!shuffleplanesFormats(step.map).length)throw new VideoFilterParseError('No negotiable pixel format accepts the shuffleplanes mapping');
 return singlePad(step);
};
/** filter_frame plus av_frame_copy into owned tight planes; output plane i is input plane map[i]. */
export function shuffleVideoPlanes(frame:VideoFrameData,step:ShuffleplanesStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!runs(step.map,layout.pixelFormat))throw new VideoShuffleplanesError('Shuffleplanes pixel format is not supported for this mapping');
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoShuffleplanesError('Shuffleplanes frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoShuffleplanesError('Invalid shuffleplanes plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoShuffleplanesError('Invalid shuffleplanes plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoShuffleplanesError('Shuffleplanes input plane storage exceeds allocation limit');
 const data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries()){
  // The accepted formats pair only planes of equal geometry.
  const from=step.map[index]!,source=layout.planes[from]!,input=frame.planes[from]!,stride=frame.linesizes[from]!;
  if(source.rowBytes!==plane.rowBytes||source.height!==plane.height)throw new VideoShuffleplanesError('Shuffleplanes plane geometry mismatch');
  for(let y=0;y<plane.height;y++){signal?.throwIfAborted();data.set(input.subarray(y*stride,y*stride+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 }
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
export const shuffleplanesOperator=defineVideoOperator<ShuffleplanesStep>({name:'shuffleplanes',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['shuffleplanes=0:0:0:0','format=yuva420p,shuffleplanes','format=yuv444p,shuffleplanes=0:2:1:0','format=gbrp,shuffleplanes=map0=2:map1=0:map2=1:map3=0,hflip'],
 parse,
 formats:step=>shuffleplanesFormats(step.map),
 validate:(pixelFormat,step)=>{if(!runs(step.map,pixelFormat))throw new VideoShuffleplanesError('Shuffleplanes pixel format is not supported for this mapping');},
 frame:shuffleVideoPlanes});
