// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_chromakey.c (chromakey). See ../../NOTICE-CHROMAKEY.
import {chromakeyGeometry,chromakeyVideoFrame,parseChromakeyOptions} from '../video-chromakey.js';
import type {ChromakeySettings} from '../video-chromakey.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
export type ChromakeyStep=ChromakeySettings<'chromakey'>;
/** Native chromakey_fmts in declared order (native-endian names). Only yuva420p has frame storage here; any other pick is refused by name. */
const formats=Object.freeze('yuva420p yuva422p yuva444p yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le'.split(' '));
export const chromakeyOperator=defineVideoOperator<ChromakeyStep>({name:'chromakey',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuva420p,chromakey=threads=1','format=yuva420p,chromakey=green:0.1:0.2:threads=1,hflip','format=yuva420p,chromakey=color=0x808080:similarity=0.5:yuv=1:threads=1'],
 parse:token=>singlePad(parseChromakeyOptions('chromakey',token.options)),
 formats:()=>formats,
 geometry:(step,[input])=>chromakeyGeometry(step,input!.width,input!.height),
 frame:(frame,step,options)=>chromakeyVideoFrame(frame,step,options)});
