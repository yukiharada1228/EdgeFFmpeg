// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_copy.c. See ../../NOTICE-VIDEO-COPY.
import {singlePad,defineVideoOperator} from './descriptor.js';
import {bareStep} from './options.js';
export type CopyStep={readonly name:'copy'};
/** Native copies every non-hwaccel format unchanged, so every table format is accepted and frames pass as identity. */
export const copyOperator=defineVideoOperator<CopyStep>({name:'copy',role:'identity',paths:['linear','graph','stream','actor','timed'],examples:['copy','copy,hflip','format=nv12,copy,vflip'],
 parse:token=>singlePad(bareStep('copy',token))});
