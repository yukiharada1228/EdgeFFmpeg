// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/f_perms.c. See ../../NOTICE-PERMS.
import {filterOptions} from '../video-syntax.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
export type VideoPermsMode='none'|'ro'|'rw'|'toggle'|'random';
export type PermsStep={readonly name:'perms';readonly mode:VideoPermsMode;readonly seed:bigint|null};
const modes:readonly VideoPermsMode[]=['none','ro','rw','toggle','random'];
/** f_perms.c changes only frame writability (ff_inlink_make_frame_writable or av_frame_clone); pixels, size, format and timestamps
 * never change and there is no query_formats, so the step is the identity over the whole table on every path. Options follow the
 * AVOption order mode, seed (positional, then named; the last repeat wins). random needs an explicit seed: the default -1 calls
 * av_get_random_seed. Numeric and expression mode values, the generic enable= timeline and runtime commands are refused. */
export const permsOperator=defineVideoOperator<PermsStep>({name:'perms',role:'identity',paths:['linear','graph','stream','actor','timed'],examples:['perms','perms=ro,hflip','perms=mode=random:seed=7,vflip','format=nv12,perms=toggle:0'],
 parse(token){
  let mode:VideoPermsMode='none',seed:bigint|null=null;
  for(const {key,value}of filterOptions(token.options,['mode','seed'])){
   if(key==='mode'){if(!modes.includes(value as VideoPermsMode))throw new VideoFilterParseError(`Unsupported perms mode: ${value}`);mode=value as VideoPermsMode;}
   else if(key==='seed'){if(!/^(-1|0|[1-9]\d{0,9})$/.test(value)||BigInt(value)>4294967295n)throw new VideoFilterParseError(`Invalid perms seed: ${value}`);seed=value==='-1'?null:BigInt(value);}
   else throw new VideoFilterParseError(`Unsupported perms option: ${key}`);
  }
  if(mode==='random'&&seed===null)throw new VideoFilterParseError('perms random mode requires an explicit seed');
  return singlePad(Object.freeze({name:'perms',mode,seed}));
 }});
