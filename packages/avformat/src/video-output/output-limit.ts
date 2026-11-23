import type {Rational} from '@edge-ffmpeg/avutil';
import type {SyncRun} from './sync.js';
/** Clips compressed runs; a deadline closes only when an actual run exceeds it.
 * A later passthrough frame may repeat the last accepted PTS. */
export function createVideoOutputLimit(options:{readonly maxFrames:bigint|null;readonly durationUs:bigint|null;readonly timeBase:Rational}){
 const {maxFrames,durationUs}=options,timeBase=Object.freeze({...options.timeBase});
 if(timeBase.num<=0n||timeBase.den<=0n||maxFrames!==null&&(typeof maxFrames!=='bigint'||maxFrames<0n)||durationUs!==null&&(typeof durationUs!=='bigint'||durationUs<0n))throw new Error('Invalid video output limit');
 const deadline=durationUs===null?null:(durationUs*timeBase.den+timeBase.num*1000000n-1n)/(timeBase.num*1000000n);let frames=0n,closed=maxFrames===0n;
 return Object.freeze({get frames(){return frames;},get closed(){return closed;},take<T>(run:SyncRun<T>):SyncRun<T>|null{
  if(closed)return null;if(run.count<0n||run.timeBase.num!==timeBase.num||run.timeBase.den!==timeBase.den)throw new Error('Invalid output run or clock');
  let count=run.count;if(maxFrames!==null&&count>maxFrames-frames)count=maxFrames-frames;
  if(deadline!==null&&run.firstPts+count>deadline)count=deadline>run.firstPts?deadline-run.firstPts:0n;
  if(count<run.count||maxFrames!==null&&frames+count>=maxFrames)closed=true;
  frames+=count;return count===0n?null:Object.freeze({...run,count});
 }});
}
