// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned libavutil/mathematics.c av_rescale_delta and
// fftools/ffmpeg_mux.c mux_fixup_ts. See ../../NOTICE-MP4-MUX.
import {Mp4Error} from './boxes.js';
/** Stateful sample clock used by Native audio streamcopy with coarse timestamps. */
export function createAacCopyClock(input:{readonly num:bigint;readonly den:bigint},sampleRate:number,frameSamples:number) {
 if(input.num<=0n||input.den<=0n||!Number.isSafeInteger(sampleRate)||sampleRate<=0||!Number.isSafeInteger(frameSamples)||frameSamples<0)throw new Mp4Error('invalid-data','Invalid AAC copy clock');
 const num=input.num*BigInt(sampleRate),den=input.den,frame=BigInt(frameSamples),max=(1n<<63n)-1n;
 const floor=(n:bigint)=>n>=0n?n/den:-((-n+den-1n)/den),ceil=(n:bigint)=>-floor(-n),nearest=(n:bigint)=>n>=0n?(n+den/2n)/den:-((-n+den/2n)/den);
 let last:bigint|null=null;
 return (timestamp:bigint):bigint=>{
  if(timestamp< -max||timestamp>max)throw new Mp4Error('invalid-data','Invalid AAC copy timestamp');
  const simple=()=>nearest(timestamp*num);
  let current:bigint;
  if(last===null||frame===0n||num<=den)current=simple();
  else {
   const a=floor((2n*timestamp-1n)*num)>>1n,b=(ceil((2n*timestamp+1n)*num)+1n)>>1n;
   current=last<2n*a-b||last>2n*b-a?simple():last<a?a:last>b?b:last;
  }
  last=current+frame;
  if(current< -max||current>max||last< -max||last>max)throw new Mp4Error('invalid-data','AAC copy timestamp overflow');
  return current;
 };
}
