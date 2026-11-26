// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_colorkey.c (colorkey). See ../../NOTICE-COLORKEY.
import {colorkeyPixelFormats,colorkeyVideoFrame,parseColorkeyOptions} from '../video-colorkey.js';
import type {VideoColorkeySettings} from '../video-colorkey.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
export type ColorkeyStep=VideoColorkeySettings&{readonly name:'colorkey'};
/** formats() is the shared native list in declared order; rgba64 and bgra64 picks have no storage and are refused by name.
 * enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const colorkeyOperator=defineVideoOperator<ColorkeyStep>({name:'colorkey',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['colorkey','format=rgba,colorkey','format=bgra,colorkey=gray:0.3:0.2','format=argb,colorkey=color=0x336699@0.5:similarity=0.5,hflip','format=abgr,colorkey=white:1'],
 parse(token){try{return singlePad(parseColorkeyOptions('colorkey',token.options) as ColorkeyStep);}catch(error){throw new VideoFilterParseError((error as Error).message);}},
 formats:()=>colorkeyPixelFormats,
 frame:(frame,step,options)=>colorkeyVideoFrame(frame,step,options)});
