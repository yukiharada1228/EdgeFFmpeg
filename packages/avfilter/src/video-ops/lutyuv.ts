// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_lut.c. See ../../NOTICE-LUT.
import {lutGeometry,lutPixelFormats,lutVideoFrame,parseLutOptions} from '../video-lut.js';
import type {LutFilterStep} from '../video-lut.js';
import type {FilterToken} from '../filter-topology.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
export type LutyuvStep=LutFilterStep&{readonly name:'lutyuv'};
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const lutyuvOperator=defineVideoOperator<LutyuvStep>({name:'lutyuv',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=yuv420p,lutyuv','format=yuv444p,lutyuv=y=negval','format=yuva420p,lutyuv=u=128:v=128:a=maxval-val','format=yuv422p,lutyuv=y=clip(val*3\\,16\\,235),hflip'],
 parse:(token:FilterToken)=>singlePad(parseLutOptions('lutyuv',token.options) as LutyuvStep),
 formats:()=>lutPixelFormats.lutyuv,
 geometry:(step,[input])=>lutGeometry(step,input!),
 frame:(frame,step,options)=>lutVideoFrame(frame,step,options)});
