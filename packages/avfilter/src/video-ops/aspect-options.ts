// SPDX-License-Identifier: LGPL-2.1-or-later
// Option semantics adapted from pinned FFmpeg vf_aspect.c. See ../../NOTICE and ../../NOTICE-VIDEO-OPS.
import {compileExpression} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {aspectVariables} from '../activation/set-aspect.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import type {ActorFrameContext} from './descriptor.js';
export type AspectStep<N extends 'setsar'|'setdar'>={readonly name:N;readonly frameSampleAspectRatio?:Rational;readonly expression:string;readonly max:number};
export function aspectPads<N extends 'setsar'|'setdar'>(name:N,token:FilterToken):FilterPads<AspectStep<N>>{
 let expression='0',max=100;for(const option of filterOptions(token.options,[name==='setsar'?'sar':'dar','max'])){if([name==='setsar'?'sar':'dar','ratio','r'].includes(option.key))expression=option.value;else if(option.key==='max'){max=filterIntegerOption(option.value,{min:1,max:2147483647,defaultValue:100});}else throw new Error('Unsupported setsar option');}try{compileExpression(expression,{numericProfile:'linux-x64',constants:aspectVariables});}catch(error){if(!/^\s*[+]?\d+\s*:\s*[+]?\d+\s*$/.test(expression))throw error;}return {inputs:1,outputs:1,configuration:Object.freeze({name,expression,max})};
}
/** Frames carry the configured output aspect; setdar stores the frame value resolved at configuration. */
export const aspectFrame=<N extends 'setsar'|'setdar'>(frame:VideoFrameData,step:AspectStep<N>,context:ActorFrameContext):VideoFrameData=>({...frame,metadata:{...frame.metadata,sampleAspectRatio:step.frameSampleAspectRatio??context.configured.sampleAspectRatio!}});
