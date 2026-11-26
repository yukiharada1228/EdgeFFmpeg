// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_chromakey.c (chromahold). See ../../NOTICE-CHROMAKEY.
import {chromaholdVideoFrame,parseChromakeyOptions} from '../video-chromakey.js';
import type {ChromakeySettings} from '../video-chromakey.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
export type ChromaholdStep=ChromakeySettings<'chromahold'>;
/** Native hold_pixel_fmts in declared order (native-endian names). yuv420p, yuv422p, yuv444p and yuva420p have frame storage here;
 * any other pick is refused by name. */
const formats=Object.freeze('yuv420p yuv422p yuv444p yuva420p yuva422p yuva444p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv444p12le yuv422p12le yuv420p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le'.split(' '));
export const chromaholdOperator=defineVideoOperator<ChromaholdStep>({name:'chromahold',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuv420p,chromahold','format=yuv422p,chromahold=green:0.1:0.2,vflip','format=yuva420p,chromahold=color=0x808080:similarity=0.5:yuv=1','format=yuv444p,chromahold=red:0.3'],
 parse:token=>singlePad(parseChromakeyOptions('chromahold',token.options)),
 formats:()=>formats,
 frame:(frame,step,options)=>chromaholdVideoFrame(frame,step,options)});
