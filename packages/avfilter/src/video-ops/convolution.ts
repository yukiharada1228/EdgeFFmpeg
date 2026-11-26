// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_convolution.c (convolution). See ../../NOTICE-CONVOLUTION.
import {convolutionGeometry,convolutionPixelFormats,convolveVideoFrame,parseConvolutionOptions,VideoConvolutionError} from '../video-convolution.js';
import type {VideoConvolutionSettings} from '../video-convolution.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
export type ConvolutionStep={readonly name:'convolution'}&VideoConvolutionSettings;
export function parseConvolutionStep(options:string|null):ConvolutionStep{
 try{return Object.freeze({name:'convolution' as const,...parseConvolutionOptions(options)});}catch(error){if(error instanceof VideoConvolutionError)throw new VideoFilterParseError(error.message);throw error;}
}
/** Stateless per-frame operator over the full native pix_fmts list; enable= and runtime commands are refused. */
export const convolutionOperator=defineVideoOperator<ConvolutionStep>({name:'convolution',role:'frame',paths:['linear','graph','stream','actor','timed'],
 examples:['convolution','convolution=0m=0 -1 0 -1 5 -1 0 -1 0','convolution=1 1 1 1 1 1 1 1 1:0rdiv=1:0bias=8,hflip','convolution=0m=1 2 3 4 5 4 3 2 1:0mode=row:0rdiv=0.04','convolution=0m=-1 0 1:0mode=column,vflip','format=yuv444p,convolution=1 4 6 4 1 4 16 24 16 4 6 24 36 24 6 4 16 24 16 4 1 4 6 4 1:0 0 0 0 1 0 0 0 0:0 -1 0 -1 4 -1 0 -1 0'],
 parse:token=>singlePad(parseConvolutionStep(token.options)),
 formats:()=>convolutionPixelFormats,
 geometry:(step,[input])=>{if(!input)throw new VideoConvolutionError('Convolution needs one input');convolutionGeometry(input.format,input.width,input.height,step);return {width:input.width,height:input.height};},
 frame:(frame,step,options)=>convolveVideoFrame(frame,step,options)});
