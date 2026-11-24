// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_epx.c. See ../../NOTICE-EPX.
import {epxGeometry,epxPixelFormats,epxVideoFrame,parseEpxOptions} from '../video-epx.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export type EpxStep={readonly name:'epx';readonly n:2|3};
/** Native query_formats intersected with the negotiation table, in table order. */
const formats=Object.freeze(negotiationOrder.filter(format=>epxPixelFormats.includes(format)));
/** Uniform n-times upscale: the default timed geometry keeps the input sample aspect ratio, as native does. */
export const epxOperator=defineVideoOperator<EpxStep>({name:'epx',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['epx','epx=n=2','epx=2,hflip','scale=3:2,epx=n=3,vflip'],
 parse(token){let settings;try{settings=parseEpxOptions(token.options);}catch(error){throw new VideoFilterParseError((error as Error).message);}return singlePad(Object.freeze({name:'epx' as const,n:settings.n}));},
 formats:()=>formats,
 validate:(pixelFormat,step)=>{epxGeometry(pixelFormat,1,1,step);},
 geometry:(step,[input])=>epxGeometry(input!.format,input!.width,input!.height,step),
 frame:(frame,step,options)=>epxVideoFrame(frame,step,options)});
