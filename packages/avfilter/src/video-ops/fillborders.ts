// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_fillborders.c. See ../../NOTICE-FILLBORDERS.
import {fillbordersPixelFormats,fillbordersPlanes,fillbordersVideoFrame,parseFillbordersOptions} from '../video-fillborders.js';
import type {FillbordersMode} from '../video-fillborders.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export type FillbordersStep={readonly name:'fillborders';readonly left:number;readonly right:number;readonly top:number;readonly bottom:number;readonly mode:FillbordersMode;readonly color:readonly [number,number,number,number]};
/** Native query_formats intersected with the negotiation table, in table order. */
const formats=Object.freeze(negotiationOrder.filter(format=>fillbordersPixelFormats.includes(format)));
if(!formats.length)throw new Error('Fillborders has no negotiable format');
/** Runtime commands and enable= are refused; border checks depend on the negotiated plane sizes. */
export const fillbordersOperator=defineVideoOperator<FillbordersStep>({name:'fillborders',role:'frame',paths:['linear','graph','stream','actor','timed'],
 examples:['fillborders=left=2:right=1:top=3:bottom=2','fillborders=1:3:2:1:mirror','fillborders=2:2:1:3:mode=fixed:color=0x4080c0','fillborders=3:1:2:2:reflect,hflip','fillborders=4:4:4:4:wrap','fillborders=3:2:4:1:fade:#ff8000','fillborders=1:2:2:3:margins,vflip'],
 parse:token=>singlePad(Object.freeze({name:'fillborders' as const,...parseFillbordersOptions(token.options)})),
 formats:()=>formats,
 geometry(step,[input]){if(!input)throw new Error('Fillborders needs one input');fillbordersPlanes(input.format,input.width,input.height,step);return {width:input.width,height:input.height};},
 validate:(pixelFormat)=>{if(!fillbordersPixelFormats.includes(pixelFormat))throw new Error('Fillborders pixel format is not supported');},
 frame:(frame,step,options)=>fillbordersVideoFrame(frame,step,options)});
