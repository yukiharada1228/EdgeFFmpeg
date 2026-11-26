// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_median.c and median_template.c. See ../../NOTICE-MEDIAN.
import {medianPlan,medianStorageFormats,medianVideoFrame,parseMedianOptions,VideoMedianError} from '../video-median.js';
import type {VideoMedianSettings} from '../video-median.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
import {executableFormat} from './formats.js';
export type MedianStep={readonly name:'median'}&VideoMedianSettings;
/** The pinned vf_median.c pix_fmts in declared order (native-endian names). Frames run in medianStorageFormats, its eight-bit
 * members with frame storage; a negotiated format without storage is refused by name before output. */
export const medianPixelFormats:readonly string[]=Object.freeze('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p gbrp gbrap gray gray9le yuv420p9le yuv422p9le yuv444p9le gbrp9le yuva420p9le yuva422p9le yuva444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le gray10le gray12le gray14le gray16le'.split(' '));
if(!medianStorageFormats.every(format=>medianPixelFormats.includes(format)&&executableFormat(format)))throw new Error('Median layouts must be executable native formats');
/** Stateless per-frame operator; enable= and runtime commands are refused. Native clips the radii to small planes with a warning. */
export const medianOperator=defineVideoOperator<MedianStep>({name:'median',role:'frame',paths:['linear','graph','stream','actor','timed'],
 examples:['median','median=radius=2:radiusV=1','median=3:1:0:0.3,hflip','format=yuv420p,median=1:6:2:1','median=radius=7:percentile=0'],
 parse:token=>singlePad(Object.freeze({name:'median' as const,...parseMedianOptions(token.options)})),
 formats:()=>medianPixelFormats,
 geometry(step,[input]){if(!input)throw new VideoMedianError('Median needs one input');medianPlan(input.format,input.width,input.height,step);return {width:input.width,height:input.height};},
 frame:(frame,step,options)=>medianVideoFrame(frame,step,options)});
