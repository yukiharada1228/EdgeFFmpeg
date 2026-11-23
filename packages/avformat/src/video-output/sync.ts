// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped rawvideo/framecrc timing adapts fftools/ffmpeg_filter.c
// adjust_frame_pts_to_encoder_tb, video_sync_process and fg_output_frame at
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8. Project-wide licensing remains unaudited.
import {rescale} from '@edge-ffmpeg/avutil';
import type {Rational,Timestamp} from '@edge-ffmpeg/avutil';
export type VideoSyncMode='cfr'|'vscfr'|'vfr'|'passthrough';
export interface SyncFrame<T>{readonly payload:T;readonly pts:Timestamp;readonly duration:bigint}
export interface SyncRun<T>{readonly payload:T;readonly firstPts:bigint;readonly count:bigint;readonly duration:bigint;readonly timeBase:Rational}
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
function clock(value:Rational){if(typeof value.num!=='bigint'||typeof value.den!=='bigint'||value.num<1n||value.den<1n||value.num>2147483647n||value.den>2147483647n)throw new Error('Unsupported encoder clock');return Object.freeze({...value});}
function bounded(value:bigint){if(value<=MIN||value>=MAX)throw new Error('Encoder timestamp outside supported signed64 range');return value;}
/** Native llrint/llrintf use nearest-even under the default floating-point environment. */
export function roundEven(value:number):bigint{if(!Number.isFinite(value)||value<Number(MIN)||value>=Number(MAX))throw new Error('Unrepresentable native rounding result');const floor=Math.floor(value),fraction=value-floor;return BigInt(fraction<0.5?floor:fraction>0.5?floor+1:floor%2===0?floor:floor+1);}
export function encoderPts(stamp:Timestamp,target:Rational,startTimeUs:bigint){
 const source=clock(stamp.timeBase),out=clock(target);bounded(stamp.value);const bits=Math.max(0,Math.min(16,29-Math.floor(Math.log2(Number(out.den))))),scale=1n<<BigInt(bits),extended={num:out.num,den:out.den*scale},offsetBase={num:1n,den:1000000n},precise=bounded(rescale(stamp.value,source,extended))-bounded(rescale(startTimeUs,offsetBase,extended));
 let exact=Number(bounded(precise))/Number(scale);if(!Number.isInteger(exact))exact+=(exact<0?-1:1)/131072;
 return {exact,rounded:bounded(rescale(stamp.value,source,out)-rescale(startTimeUs,offsetBase,out))};
}
export function createVideoEncoderSync<T>(options:{readonly mode:VideoSyncMode;readonly timeBase:Rational;readonly startTimeUs?:bigint;readonly maxCopiesPerFrame?:bigint}){
 if(!['cfr','vscfr','vfr','passthrough'].includes(options.mode))throw new Error('Unknown video synchronization mode');const mode=options.mode,timeBase=clock(options.timeBase),startTimeUs=options.startTimeUs??0n,maxCopies=options.maxCopiesPerFrame??3240000n;
 if(typeof startTimeUs!=='bigint'||typeof maxCopies!=='bigint'||maxCopies<1n)throw new Error('Invalid video synchronization budget');
 let nextPts=0n,frameNumber=0n,last:{payload:T;duration:bigint}|null=null,lastDropped=false,closed=false;const history=[0n,0n,0n];
 const emit=(current:{payload:T;duration:bigint}|null,count:bigint,previous:bigint)=>{
  const runs:SyncRun<T>[]=[];let first=nextPts,actual=0n;const append=(frame:{payload:T;duration:bigint},copies:bigint)=>{if(copies>0n){runs.push(Object.freeze({payload:frame.payload,firstPts:first,count:copies,duration:frame.duration,timeBase}));first+=copies;actual+=copies;}};
  const old=last?previous<count?previous:count:0n;if(old>0n)append(last!,old);if(current&&count>old)append(current,count-old);bounded(first);nextPts=first;frameNumber+=actual;return Object.freeze(runs);
 };
 const updateHistory=(previous:bigint)=>{history[2]=history[1]!;history[1]=history[0]!;history[0]=previous;};
 return Object.freeze({timeBase,
  get nextPts(){return nextPts;},get frameNumber(){return frameNumber;},get lastDropped(){return lastDropped;},
  push(frame:SyncFrame<T>):readonly SyncRun<T>[] {
   if(closed)throw new Error('Video synchronization is closed');if(typeof frame.duration!=='bigint'||frame.duration<0n||frame.duration>=MAX)throw new Error('Invalid frame duration');
   const durationInput=Number(frame.duration)*(Number(frame.pts.timeBase.num)/Number(frame.pts.timeBase.den))/(Number(timeBase.num)/Number(timeBase.den));let duration=durationInput,sync=encoderPts(frame.pts,timeBase,startTimeUs).exact,delta0=sync-Number(nextPts),delta=delta0+duration,count=1n,previous=0n;
   if(delta0<0&&delta>0&&mode!=='passthrough'){sync=Number(nextPts);duration+=delta0;delta0=0;}
   if(mode==='vscfr'&&frameNumber===0n&&delta0>=0.5){delta=duration;delta0=0;nextPts=roundEven(sync);}
   let outputDuration:bigint;
   if(mode==='cfr'||mode==='vscfr'){if(delta<-1.1)count=0n;else if(delta>1.1){count=roundEven(Math.fround(delta));if(delta0>1.1)previous=roundEven(Math.fround(delta0-0.6));}outputDuration=1n;}
   else {if(mode==='vfr'){if(delta<=-0.6)count=0n;else if(delta>0.6)nextPts=roundEven(sync);}else nextPts=roundEven(sync);outputDuration=roundEven(duration);}
   updateHistory(previous);
   // Pinned default dts_error_threshold is108000; Native skips >threshold*30 copies.
   const duplicate=count>((previous>0n&&lastDropped?1n:0n)+(count>previous?1n:0n));let skipped=false;
   if(duplicate&&count>3240000n){count=0n;skipped=true;}if(count>maxCopies)throw new Error('Video frame duplication exceeds budget');
   if(!skipped)lastDropped=count===previous;const current={payload:frame.payload,duration:outputDuration},runs=emit(current,count,previous);last=current;return runs;
  },
  finish():readonly SyncRun<T>[] {if(closed)return Object.freeze([]);closed=true;if(last===null||frameNumber===0n)return Object.freeze([]);const sorted=[...history].sort((a,b)=>a<b?-1:a>b?1:0),copies=sorted[1]!;updateHistory(copies);if(copies>3240000n)return Object.freeze([]);if(copies>maxCopies)throw new Error('Video flush duplication exceeds budget');lastDropped=false;return emit(null,copies,copies);}
 });
}
