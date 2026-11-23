// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped CFR startup semantics follow pinned fftools/ffmpeg_filter.c video_sync_process.
import {videoFrameRate} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import {resolveDuration} from './time-range.js';
import type {TimeOptions} from './time-range.js';
import {rawVideoTimeRange} from './video-time-range.js';
const min=(a:bigint,b:bigint)=>a<b?a:b,max=(a:bigint,b:bigint)=>a>b?a:b;
const near=(a:bigint,b:bigint)=>a<0n?-((-a+b/2n)/b):(a+b/2n)/b;
export function complexVideoTimeRange(total:bigint,frameRate:Rational,input:TimeOptions,output:TimeOptions,options:{readonly format:'rawvideo'|'framecrc';readonly frameBytes:number;readonly inputSeekSet:boolean;readonly outputSeekSet:boolean;readonly maxFrames:bigint|null}){
 if(options.format==='framecrc'){
  const range=rawVideoTimeRange(total,frameRate,input,output,{...options,copy:false});return Object.freeze({...range,sourceFrames:range.frames,indicesForSource(index:bigint):readonly bigint[]{if(index<0n||index>=range.frames)throw new Error('Source frame outside VFR range');return Object.freeze([index]);}});
 }
 const rate=videoFrameRate(frameRate),base=1000000n*rate.den,toFrames=(time:bigint)=>near(time*rate.num,base),inputBase=toFrames(input.seek),inputDuration=resolveDuration(input),outputDuration=resolveDuration(output);
 if(typeof total!=='bigint'||total<0n||input.seek<0n||output.seek<0n||options.maxFrames!==null&&options.maxFrames<0n)throw new Error('Invalid CFR time plan');
 let start=min(total,inputBase),end=total;if(inputDuration!==null){const count=toFrames(inputDuration);if(count>0n)end=min(end,inputBase+count);}start=min(end,max(start,inputBase+toFrames(output.seek)));
 if(outputDuration!==null){const count=toFrames(outputDuration);if(count>0n)end=min(end,start+count);}
 const bits=Math.max(0,Math.min(16,29-Math.floor(Math.log2(Number(rate.num))))),scale=1n<<BigInt(bits),offset=near(output.seek*rate.num*scale,base),delta=(start-inputBase)*scale-offset,initialCopies=2n*delta===scale?2n:1n;
 let frames=end>start?end-start+initialCopies-1n:0n;if(outputDuration!==null)frames=min(frames,(outputDuration*rate.num+base-1n)/base);if(options.maxFrames!==null)frames=min(frames,options.maxFrames);
 const sourceFrames=frames>0n?max(1n,frames-initialCopies+1n):0n;
 return Object.freeze({start,frames,sourceFrames,
  indicesForSource(index:bigint):readonly bigint[]{if(index<0n||index>=sourceFrames)throw new Error('Source frame outside CFR range');const first=index===0n?0n:index+initialCopies-1n,count=index===0n?min(initialCopies,frames):1n;return Object.freeze(count===2n?[first,first+1n]:[first]);},
  ptsForFrame(index:bigint){if(index<0n||index>=frames)throw new Error('CFR output index outside range');return index;},
  durationForFrame(index:bigint){if(index<0n||index>=frames)throw new Error('CFR output index outside range');return 1n;}
 });
}
