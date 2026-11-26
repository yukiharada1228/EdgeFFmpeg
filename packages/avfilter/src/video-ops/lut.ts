// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_lut.c. See ../../NOTICE-LUT.
import {lutGeometry,lutPixelFormats,lutVideoFrame,parseLutOptions} from '../video-lut.js';
import type {LutFilterStep} from '../video-lut.js';
import type {FilterToken} from '../filter-topology.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
export type LutStep=LutFilterStep&{readonly name:'lut'};
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const lutOperator=defineVideoOperator<LutStep>({name:'lut',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['lut','lut=negval','lut=c0=val*2,hflip','lut=clip(val\\,16\\,235):c3=clipval','format=gbrp,lut=r=negval:g=maxval-val:b=if(lt(val\\,128)\\,0\\,255)'],
 parse:(token:FilterToken)=>singlePad(parseLutOptions('lut',token.options) as LutStep),
 formats:()=>lutPixelFormats.lut,
 geometry:(step,[input])=>lutGeometry(step,input!),
 frame:(frame,step,options)=>lutVideoFrame(frame,step,options)});
