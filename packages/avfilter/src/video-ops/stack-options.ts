// SPDX-License-Identifier: LGPL-2.1-or-later
// Option semantics adapted from pinned FFmpeg vf_stack.c. See ../../NOTICE and ../../NOTICE-VIDEO-OPS.
import {filterOptions} from '../video-syntax.js';
import {stackGeometry,stackVideoFrames} from '../video-stack.js';
import type {VideoStackDirection} from '../video-stack.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import {defineVideoOperator} from './descriptor.js';
import type {VideoOperatorDescriptor} from './descriptor.js';
export type StackStep<N extends 'hstack'|'vstack'>={readonly name:N;readonly shortest:boolean};
function stackPads<N extends 'hstack'|'vstack'>(name:N,token:FilterToken):FilterPads<StackStep<N>>{
 let inputs=2,shortest=false;for(const option of filterOptions(token.options,['inputs','shortest'])){
  if(option.key==='inputs'){const count=Number(option.value);if(!/^\d+$/.test(option.value)||!Number.isInteger(count)||count<2||count>32)throw new Error('Only bounded decimal stack input counts are implemented');inputs=count;}
  else if(option.key==='shortest'&&['0','1','true','false','yes','no','on','off'].includes(option.value))shortest=['1','true','yes','on'].includes(option.value);
  else throw new Error('Unsupported stack option');
 }return {inputs,outputs:1,configuration:Object.freeze({name,shortest})};
}
/** hstack and vstack differ only by direction. */
export function stackOperator<N extends 'hstack'|'vstack'>(name:N,direction:VideoStackDirection):VideoOperatorDescriptor<StackStep<N>>{
 return defineVideoOperator<StackStep<N>>({name,role:'join',paths:['graph','stream','actor','timed'],examples:[`split,${name}`,`split=3[a][b][c];[a][b][c]${name}=inputs=3:shortest=1`],
  parse:token=>stackPads(name,token),geometry:(_step,inputs)=>stackGeometry(inputs,direction),
  combine:(frames,_step,options)=>stackVideoFrames(frames,direction,options),stateful:()=>true});
}
