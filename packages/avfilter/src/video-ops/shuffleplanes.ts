// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_shuffleplanes.c. See ../../NOTICE-SHUFFLEPLANES.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export type ShuffleplanesMap=readonly [number,number,number,number];
export type ShuffleplanesStep={readonly name:'shuffleplanes';readonly map:ShuffleplanesMap};
export class VideoShuffleplanesError extends Error {}
/** av_pix_fmt_count_planes and log2_chroma_w|log2_chroma_h of every negotiable format. */
const traits:Readonly<Record<string,readonly [number,boolean]>>={yuv420p:[3,true],rgb24:[1,false],bgr24:[1,false],yuv422p:[3,true],yuv444p:[3,false],gray:[1,false],nv12:[2,true],nv21:[2,true],argb:[1,false],rgba:[1,false],abgr:[1,false],bgra:[1,false],yuva420p:[4,true],gbrp:[3,false]};
/** query_formats: every map[i] below the plane count; subsampled formats keep planes 1 and 2 within {1,2}. */
export function shuffleplanesFormats(map:ShuffleplanesMap):readonly string[]{
 return negotiationOrder.filter(format=>{const [planes,subsampled]=traits[format]!;return map.every((value,i)=>value<planes&&(!subsampled||(i===1||i===2)===(value===1||value===2)));});
}
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
 if(!shuffleplanesFormats(step.map).includes(layout.pixelFormat))throw new VideoShuffleplanesError('Shuffleplanes pixel format is not supported for this mapping');
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
 validate:(pixelFormat,step)=>{if(!shuffleplanesFormats(step.map).includes(pixelFormat))throw new VideoShuffleplanesError('Shuffleplanes pixel format is not supported for this mapping');},
 frame:shuffleVideoPlanes});
