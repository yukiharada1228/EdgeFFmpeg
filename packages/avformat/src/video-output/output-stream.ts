import type {Rational} from '@edge-ffmpeg/avutil';
import {createVideoEncoderSync} from './sync.js';
import type {SyncFrame,SyncRun,VideoSyncMode} from './sync.js';
import {createVideoTimeTrim} from './video-trim.js';
import {createVideoOutputLimit} from './output-limit.js';
import {fillVideoDuration} from './output-clock.js';
export interface VideoOutputStreamOptions {readonly mode:VideoSyncMode;readonly filterTimeBase:Rational;readonly encoderTimeBase:Rational;readonly sinkFrameRate:Rational;readonly startUs?:bigint;readonly durationUs?:bigint|null;readonly maxFrames?:bigint|null;readonly maxCopiesPerFrame?:bigint;readonly signal?:AbortSignal}
/** Source payloads must remain immutable while retained as the previous frame. */
export async function* synchronizeVideoOutput<T>(frames:AsyncIterable<SyncFrame<T>>,options:VideoOutputStreamOptions):AsyncIterable<SyncRun<T>>{
 options=Object.freeze({...options,filterTimeBase:Object.freeze({...options.filterTimeBase}),encoderTimeBase:Object.freeze({...options.encoderTimeBase}),sinkFrameRate:Object.freeze({...options.sinkFrameRate})});
 const {signal}=options;signal?.throwIfAborted();const startUs=options.startUs??0n,durationUs=options.durationUs??null,trim=createVideoTimeTrim(options.filterTimeBase,{startUs,durationUs}),limit=createVideoOutputLimit({timeBase:options.encoderTimeBase,maxFrames:options.maxFrames??null,durationUs}),sync=createVideoEncoderSync<T>({mode:options.mode,timeBase:options.encoderTimeBase,startTimeUs:startUs,...(options.maxCopiesPerFrame===undefined?{}:{maxCopiesPerFrame:options.maxCopiesPerFrame})});
 if(limit.closed)return;const iterator=frames[Symbol.asyncIterator]();let done=false,failed=false;
 try{
  while(!limit.closed){signal?.throwIfAborted();const next=await iterator.next();signal?.throwIfAborted();if(next.done){done=true;break;}const frame=next.value,base=frame.pts.timeBase;if(base.num!==options.filterTimeBase.num||base.den!==options.filterTimeBase.den)throw new Error('Output frame clock differs from planned filter clock');
   if(!trim.accept(frame.pts.value)){if(trim.eof)break;continue;}
   const runs=sync.push({...frame,duration:fillVideoDuration(frame.duration,options.sinkFrameRate,base)});
   for(const run of runs){const selected=limit.take(run);if(selected){signal?.throwIfAborted();yield selected;}if(limit.closed)break;}
  }
  if(!limit.closed)for(const run of sync.finish()){const selected=limit.take(run);if(selected){signal?.throwIfAborted();yield selected;}if(limit.closed)break;}
 }catch(error){failed=true;throw error;}
 finally{if(!done)try{await iterator.return?.();}catch(error){if(!failed)throw error;}}
}
