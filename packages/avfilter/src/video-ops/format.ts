// SPDX-License-Identifier: LGPL-2.1-or-later
// Option semantics adapted from pinned FFmpeg vf_format.c. See ../../NOTICE and ../../NOTICE-VIDEO-OPS.
import {filterOptions} from '../video-syntax.js';
import {parseFilterPixelFormat} from '../format-pixel-format.js';
import {VideoFilterParseError,singlePad,defineVideoOperator} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export type FormatStep={readonly name:'format';readonly pixelFormat:string|null;readonly pixelFormats:readonly string[]|null};
export const formatOperator=defineVideoOperator<FormatStep>({name:'format',role:'identity',paths:['linear','graph','stream','actor','timed'],examples:['format=gray','format=pix_fmts=yuv444p|gray'],
 parse(token){
  let value:string|null=null;
  for(const option of filterOptions(token.options,['pix_fmts','color_spaces','color_ranges','alpha_modes'])){
   if(option.key!=='pix_fmts')throw new VideoFilterParseError('Color options are not implemented');value=option.value;
  }
  if(value===null)return singlePad(Object.freeze({name:'format',pixelFormat:null,pixelFormats:null}));
  const candidates=value.split('|').map(parseFilterPixelFormat);
  if(new Set(candidates).size!==candidates.length)throw new VideoFilterParseError('Duplicated pixel format');
  const pixelFormats=Object.freeze(candidates);return singlePad(Object.freeze({name:'format',pixelFormat:pixelFormats.length===1?pixelFormats[0]!:null,pixelFormats}));
 },
 formats:step=>step.pixelFormats??negotiationOrder});
