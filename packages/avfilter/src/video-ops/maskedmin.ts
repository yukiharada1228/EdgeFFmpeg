// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_maskedminmax.c (maskedmin). See ../../NOTICE-MASKEDMINMAX.
import {maskedMinMaxFrames,maskedMinMaxGeometry,maskedMinMaxPixelFormats,parseMaskedMinMax} from '../video-maskedminmax.js';
import type {MaskedMinMaxStep} from '../video-maskedminmax.js';
import {defineVideoOperator} from './descriptor.js';
export type MaskedminStep=MaskedMinMaxStep<'maskedmin'>;
export const maskedminOperator=defineVideoOperator<MaskedminStep>({name:'maskedmin',role:'join',paths:['graph','stream','actor','timed'],
 examples:['split=3[a][b][c];[a][b][c]maskedmin','split=3[a][b][c];[a]vflip[x];[b]hflip[y];[x][y][c]maskedmin=planes=1'],
 parse:token=>parseMaskedMinMax('maskedmin',token),formats:()=>maskedMinMaxPixelFormats,geometry:(_step,inputs)=>maskedMinMaxGeometry('maskedmin',inputs),
 combine:(frames,step,options)=>maskedMinMaxFrames(frames,step,options),stateful:()=>true});
