// SPDX-License-Identifier: LGPL-2.1-or-later
// Option helpers adapted from pinned FFmpeg avfilter.c and opt.c. See ../../NOTICE and ../../NOTICE-VIDEO-OPS.
import {compileExpression} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import {VideoFilterParseError,singlePad} from './descriptor.js';
/** Native timeline and reflection options are not implemented for option-free filters. */
export function bareStep<N extends string>(name:N,token:FilterToken):{readonly name:N}{
 if(filterOptions(token.options,[]).length)throw new VideoFilterParseError('Timeline and reflection options are not implemented');return Object.freeze({name});
}
/** Activation-only enable= timeline over an otherwise option-free filter. */
export function timelinePads<N extends string>(name:N,token:FilterToken):FilterPads<{readonly name:N;readonly enableExpression?:string}>{
 let enableExpression:string|undefined;for(const option of filterOptions(token.options,[])){if(option.key!=='enable')throw new Error('Unsupported flip option');enableExpression=option.value;}if(enableExpression!==undefined)compileExpression(enableExpression,{numericProfile:'linux-x64',constants:['t','n','w','h']});const resolved=singlePad(bareStep(name,{...token,options:null}));return {...resolved,configuration:Object.freeze({...resolved.configuration,...(enableExpression===undefined?{}:{enableExpression})})};
}
// LP64 strtol followed by signed32 narrowing, as used by pinned AV_OPT_TYPE_BOOL.
export function filterBoolean(value:string):boolean{
 const lower=value.toLowerCase();if(['true','y','yes','enable','enabled','on'].includes(lower))return true;if(['false','n','no','disable','disabled','off'].includes(lower))return false;
 if(value==='')return false;if(!/^[ \t\n\r\v\f]*[+-]?\d+$/.test(value))throw new Error('Invalid boolean');let n=BigInt(value.trim());n=n<-(1n<<63n)?-(1n<<63n):n>(1n<<63n)-1n?(1n<<63n)-1n:n;const narrowed=BigInt.asIntN(32,n);if(narrowed!==0n&&narrowed!==1n)throw new Error('Boolean outside range');return narrowed===1n;
}
