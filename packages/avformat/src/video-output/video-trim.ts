// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped CLI-inserted trim start/duration semantics adapt libavfilter/trim.c
// at 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
import {rescale} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
export function createVideoTimeTrim(timeBase:Rational,options:{readonly startUs:bigint|null;readonly durationUs:bigint|null}){
 if(timeBase.num<=0n||timeBase.den<=0n)throw new Error('Invalid trim timebase');
 if(options.startUs!==null&&typeof options.startUs!=='bigint'||options.durationUs!==null&&(typeof options.durationUs!=='bigint'||options.durationUs<0n))throw new Error('Unsupported trim time');
 const micro={num:1n,den:1000000n},start=options.startUs===null?null:rescale(options.startUs,micro,timeBase),duration=options.durationUs===null?0n:rescale(options.durationUs,micro,timeBase);let first:bigint|null=null,eof=false;
 return Object.freeze({get eof(){return eof;},get firstPts(){return first;},accept(pts:bigint|null):boolean{
  if(eof)return false;if(start!==null&&(pts===null||pts<start))return false;
  if(first===null&&pts!==null)first=pts;
  if(duration!==0n&&(pts===null||pts-first!>=duration)){eof=true;return false;}return true;
 }});
}
/** Encoder deadline uses exact rational comparison after synchronization. */
export function beforeVideoDeadline(pts:bigint,timeBase:Rational,durationUs:bigint|null):boolean{
 if(timeBase.num<=0n||timeBase.den<=0n||durationUs!==null&&durationUs<0n)throw new Error('Invalid encoder deadline');
 return durationUs===null||pts*timeBase.num*1000000n<durationUs*timeBase.den;
}
