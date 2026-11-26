// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_pixdesctest.c. See ../../NOTICE-PIXDESCTEST.
import {singlePad,defineVideoOperator} from './descriptor.js';
import {bareStep} from './options.js';
export type PixdescTestStep={readonly name:'pixdesctest'};
/** Native has no query_formats and copies every component through av_read_image_line2/av_write_image_line2 into a fresh buffer.
 * Every byte of the storage formats is a component, so the output equals the input and frames pass as identity. Formats without
 * storage here (pal8, padded layouts) are refused by the shared negotiator, so no padding byte is ever claimed. */
export const pixdesctestOperator=defineVideoOperator<PixdescTestStep>({name:'pixdesctest',role:'identity',paths:['linear','graph','stream','actor','timed'],examples:['pixdesctest','pixdesctest,hflip','format=nv12,pixdesctest'],
 parse:token=>singlePad(bareStep('pixdesctest',token))});
