// SPDX-License-Identifier: LGPL-2.1-or-later
// Option semantics adapted from pinned FFmpeg setpts.c. See ../../NOTICE and ../../NOTICE-VIDEO-OPS.
import {compileExpression} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {setptsVariables} from '../setpts/state.js';
import {filterBoolean} from './options.js';
import {defineVideoOperator} from './descriptor.js';
export type SetptsStep={readonly name:'setpts';readonly expression:string;readonly stripFps:boolean};
export const setptsOperator=defineVideoOperator<never,SetptsStep>({name:'setpts',role:'retime',paths:['actor','timed'],examples:['setpts=PTS*2'],
 parseTimed(token){let expression='PTS',stripFps=false;
  for(const option of filterOptions(token.options,['expr','strip_fps'])){if(option.key==='expr')expression=option.value;else if(option.key==='strip_fps')stripFps=filterBoolean(option.value);else throw new Error('Unsupported setpts option');}
  compileExpression(expression,{numericProfile:'linux-x64',constants:setptsVariables});
  return {inputs:1,outputs:1,configuration:Object.freeze({name:'setpts',expression,stripFps})};
 },
 stripsFrameRate:step=>step.stripFps,stateful:()=>true});
