// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_maskedminmax.c (maskedmax). See ../../NOTICE-MASKEDMINMAX.
import {maskedMinMaxFrames,maskedMinMaxGeometry,maskedMinMaxPixelFormats,parseMaskedMinMax} from '../video-maskedminmax.js';
import type {MaskedMinMaxStep} from '../video-maskedminmax.js';
import {defineVideoOperator} from './descriptor.js';
export type MaskedmaxStep=MaskedMinMaxStep<'maskedmax'>;
export const maskedmaxOperator=defineVideoOperator<MaskedmaxStep>({name:'maskedmax',role:'join',paths:['graph','stream','actor','timed'],
 examples:['split=3[a][b][c];[a][b][c]maskedmax','split=3[a][b][c];[a]transpose[x];[b]transpose=2[y];[c]transpose=1[z];[x][y][z]maskedmax=planes=0,transpose'],
 parse:token=>parseMaskedMinMax('maskedmax',token),formats:()=>maskedMinMaxPixelFormats,geometry:(_step,inputs)=>maskedMinMaxGeometry('maskedmax',inputs),
 combine:(frames,step,options)=>maskedMinMaxFrames(frames,step,options),stateful:()=>true});
