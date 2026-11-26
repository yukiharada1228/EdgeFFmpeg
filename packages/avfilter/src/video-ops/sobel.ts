// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_convolution.c (ff_vf_sobel, common class). See ../../NOTICE-SOBEL.
import {gradientPixelFormats,gradientVideoFrame,parseGradientOptions} from '../video-sobel.js';
import type {GradientStep} from '../video-sobel.js';
import {defineVideoOperator,singlePad} from './descriptor.js';
export type SobelStep=GradientStep<'sobel'>;
export const sobelOperator=defineVideoOperator<SobelStep>({name:'sobel',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['sobel','sobel=planes=1:scale=0.5:delta=3,hflip','sobel=15:2:-4'],
 parse:token=>singlePad(parseGradientOptions('sobel',token.options)),
 formats:()=>gradientPixelFormats,
 frame:(frame,step,options)=>gradientVideoFrame(frame,step,options)});
