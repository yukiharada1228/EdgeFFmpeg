// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_lut.c. See ../../NOTICE-LUT.
import {lutGeometry,lutPixelFormats,lutVideoFrame,parseLutOptions} from '../video-lut.js';
import type {LutFilterStep} from '../video-lut.js';
import type {FilterToken} from '../filter-topology.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
export type LutrgbStep=LutFilterStep&{readonly name:'lutrgb'};
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const lutrgbOperator=defineVideoOperator<LutrgbStep>({name:'lutrgb',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['format=rgb24,lutrgb','format=rgb24,lutrgb=r=negval:b=val*2','format=rgba,lutrgb=a=128,vflip','format=gbrp,lutrgb=g=between(val\\,64\\,192)*255'],
 parse:(token:FilterToken)=>singlePad(parseLutOptions('lutrgb',token.options) as LutrgbStep),
 formats:()=>lutPixelFormats.lutrgb,
 geometry:(step,[input])=>lutGeometry(step,input!),
 frame:(frame,step,options)=>lutVideoFrame(frame,step,options)});
