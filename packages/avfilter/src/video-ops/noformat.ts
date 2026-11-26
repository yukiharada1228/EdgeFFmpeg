// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_format.c (noformat). See ../../NOTICE-NOFORMAT.
import {filterOptions} from '../video-syntax.js';
import {parseFilterPixelFormat} from '../format-pixel-format.js';
import {VideoFilterParseError,singlePad,defineVideoOperator} from './descriptor.js';
import {negotiableFormats} from './formats.js';
export type NoformatStep={readonly name:'noformat';readonly excluded:readonly string[]};
/** invert_formats over ff_all_formats: every negotiable format (AVPixelFormat order) except the listed ones; no list restricts nothing. */
const inverted=(excluded:readonly string[])=>excluded.length?Object.freeze(negotiableFormats.filter(format=>!excluded.includes(format))):negotiableFormats;
export const noformatOperator=defineVideoOperator<NoformatStep>({name:'noformat',role:'identity',paths:['linear','graph','stream','actor','timed'],examples:['noformat=yuv420p','noformat=pix_fmts=yuv420p|rgb24,hflip','format=yuv444p,noformat=gray|yuv420p,vflip'],
 parse(token){
  let value:string|null=null;
  for(const option of filterOptions(token.options,['pix_fmts','color_spaces','color_ranges','alpha_modes'])){
   if(option.key!=='pix_fmts')throw new VideoFilterParseError('Color options are not implemented');value=option.value;
  }
  if(value===null)return singlePad(Object.freeze({name:'noformat',excluded:Object.freeze([])}));
  const excluded=value.split('|').map(parseFilterPixelFormat);
  if(new Set(excluded).size!==excluded.length)throw new VideoFilterParseError('Duplicated pixel format');
  if(!inverted(excluded).length)throw new VideoFilterParseError('noformat excludes every pixel format');
  return singlePad(Object.freeze({name:'noformat',excluded:Object.freeze(excluded)}));
 },
 formats:step=>inverted(step.excluded)});
