// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_fillborders.c. See ../../NOTICE-FILLBORDERS.
import {fillbordersPixelFormats,fillbordersPlanes,fillbordersVideoFrame,parseFillbordersOptions} from '../video-fillborders.js';
import type {FillbordersMode} from '../video-fillborders.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
import {executableFormat} from './formats.js';
export type FillbordersStep={readonly name:'fillborders';readonly left:number;readonly right:number;readonly top:number;readonly bottom:number;readonly mode:FillbordersMode;readonly color:readonly [number,number,number,number]};
/** The pinned vf_fillborders.c pix_fmts in declared order (native-endian names): planar YUV, YUVA, GBR(A)P and gray at every depth.
 * Frames run only in fillbordersPixelFormats, its eight-bit members with frame storage; any other negotiated format is refused at plan time. */
const formats=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
if(!fillbordersPixelFormats.every(format=>formats.includes(format)&&executableFormat(format)))throw new Error('Fillborders layouts must be executable native formats');
/** Runtime commands and enable= are refused; border checks depend on the negotiated plane sizes. */
export const fillbordersOperator=defineVideoOperator<FillbordersStep>({name:'fillborders',role:'frame',paths:['linear','graph','stream','actor','timed'],
 examples:['fillborders=left=2:right=1:top=3:bottom=2','fillborders=1:3:2:1:mirror','fillborders=2:2:1:3:mode=fixed:color=0x4080c0','fillborders=3:1:2:2:reflect,hflip','fillborders=4:4:4:4:wrap','fillborders=3:2:4:1:fade:#ff8000','fillborders=1:2:2:3:margins,vflip'],
 parse:token=>singlePad(Object.freeze({name:'fillborders' as const,...parseFillbordersOptions(token.options)})),
 formats:()=>formats,
 geometry(step,[input]){if(!input)throw new Error('Fillborders needs one input');fillbordersPlanes(input.format,input.width,input.height,step);return {width:input.width,height:input.height};},
 validate:(pixelFormat)=>{if(!fillbordersPixelFormats.includes(pixelFormat))throw new Error('Fillborders pixel format is not supported');},
 frame:(frame,step,options)=>fillbordersVideoFrame(frame,step,options)});
