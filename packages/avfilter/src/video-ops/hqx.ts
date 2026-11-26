// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_hqx.c. See ../../NOTICE-HQX.
import {hqxGeometry,hqxPixelFormats,hqxVideoFrame,parseHqxOptions} from '../video-hqx.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
export type HqxStep={readonly name:'hqx';readonly n:2|3|4};
/** Native query_formats in declared order: the single RGB32 format, bgra on little-endian hosts. */
const formats=hqxPixelFormats;
/** Uniform n-times upscale: the default timed geometry keeps the input sample aspect ratio, as native does. */
export const hqxOperator=defineVideoOperator<HqxStep>({name:'hqx',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['hqx','hqx=n=2','hqx=4,hflip','scale=3:2,hqx=n=3,vflip'],
 parse(token){let settings;try{settings=parseHqxOptions(token.options);}catch(error){throw new VideoFilterParseError((error as Error).message);}return singlePad(Object.freeze({name:'hqx' as const,n:settings.n}));},
 formats:()=>formats,
 validate:(pixelFormat,step)=>{hqxGeometry(pixelFormat,1,1,step);},
 geometry:(step,[input])=>hqxGeometry(input!.format,input!.width,input!.height,step),
 frame:(frame,step,options)=>hqxVideoFrame(frame,step,options)});
