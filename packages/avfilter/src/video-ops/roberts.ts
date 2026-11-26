// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_convolution.c (ff_vf_roberts, common class). See ../../NOTICE-SOBEL.
import {gradientPixelFormats,gradientVideoFrame,parseGradientOptions} from '../video-sobel.js';
import type {GradientStep} from '../video-sobel.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
export type RobertsStep=GradientStep<'roberts'>;
export const robertsOperator=defineVideoOperator<RobertsStep>({name:'roberts',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['roberts','roberts=planes=1:scale=0.5:delta=3,hflip','roberts=15:2:-4'],
 parse:token=>singlePad(parseGradientOptions('roberts',token.options)),
 formats:()=>gradientPixelFormats,
 frame:(frame,step,options)=>gradientVideoFrame(frame,step,options)});
