import {ExecutionError} from '@edge-ffmpeg/core';
import {videoFrameRate} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import {resolveDuration} from './time-range.js';
import type {TimeOptions} from './time-range.js';
export interface RawVideoTimeRange {readonly start:bigint;readonly frames:bigint;ptsForFrame(index:bigint):bigint;durationForFrame(index:bigint):bigint}
const min=(a:bigint,b:bigint)=>a<b?a:b,max=(a:bigint,b:bigint)=>a>b?a:b;
function near(value:bigint,den:bigint):bigint{return value<0n?-((-value+den/2n)/den):(value+den/2n)/den;}
/** Fixed-rate rawvideo selection, with independent native stream-copy and encode timing. */
export function rawVideoTimeRange(total:bigint,frameRate:Rational,input:TimeOptions,output:TimeOptions,options:{readonly copyTs?:boolean;readonly physicalSeek?:boolean;readonly frameBytes:number;readonly inputSeekSet:boolean;readonly copy:boolean;readonly outputSeekSet:boolean;readonly maxFrames:bigint|null}):RawVideoTimeRange{
  const rate=videoFrameRate(frameRate),base=1000000n*rate.den;
  if(!Number.isSafeInteger(options.frameBytes)||options.frameBytes<1)throw new ExecutionError('invalid-time','Invalid raw video frame size');
  if(typeof total!=='bigint'||total<0n||(options.maxFrames!==null&&(typeof options.maxFrames!=='bigint'||options.maxFrames<0n)))throw new ExecutionError('invalid-time','Invalid raw video time range');
  const inputDuration=resolveDuration(input),outputDuration=resolveDuration(output),toFrames=(time:bigint)=>near(time*rate.num,base),inputBase=toFrames(input.seek),timestampBase=options.copyTs?0n:inputBase;
  if(inputDuration!==null&&inputDuration<0n||outputDuration!==null&&outputDuration<0n)throw new ExecutionError('invalid-time','Negative raw video duration');
  const seekProbe=min(total,min((5000000n+BigInt(options.frameBytes)-1n)/BigInt(options.frameBytes),rate.num>=2000n*rate.den?21n:rate.num>=1000n*rate.den?41n:1n));
  let start=options.physicalSeek===false?0n:inputBase<0n?seekProbe:total===0n?0n:min(inputBase,total-1n),end=total;
  const lowerBound=(from:bigint,to:bigint,predicate:(index:bigint)=>boolean)=>{let low=from,high=to;while(low<high){const middle=(low+high)/2n;if(predicate(middle))high=middle;else low=middle+1n;}return low;};
  let timestamp:(absolute:bigint)=>bigint;
  if(options.copy){
    const time=(index:bigint)=>near((index-timestampBase)*base,rate.num);
    if(options.outputSeekSet)start=lowerBound(start,end,index=>time(index)>=output.seek);
    if(inputDuration!==null)end=lowerBound(start,end,index=>time(index)>=(options.copyTs?input.seek:0n)+inputDuration);
    if(outputDuration!==null)end=lowerBound(start,end,index=>time(index)>=output.seek+outputDuration);
    const offset=toFrames(output.seek);timestamp=index=>index-timestampBase-offset;
  }else{
    // Input seek rounds in the demuxer; accurate decoding then discards negative PTS.
    start=min(end,max(start,inputBase));
    if(inputDuration!==null){const count=toFrames(inputDuration);if(count>0n)end=min(end,(inputBase<0n?start:inputBase)+count);}
    start=min(end,max(start,timestampBase+toFrames(output.seek)));
    if(outputDuration!==null){const count=toFrames(outputDuration);if(count>0n)end=min(end,start+count);}
    // The native encoder timestamp path uses an extended frame time base before
    // nearest rounding. Preserve its half-frame boundary behavior explicitly.
    const bits=Math.max(0,Math.min(16,29-Math.floor(Math.log2(Number(rate.num))))),scale=1n<<BigInt(bits),offset=near(output.seek*rate.num*scale,base);
    const passthrough=(index:bigint)=>near((index-timestampBase)*scale-offset,scale),origin=max(0n,passthrough(start));
    // Both default VFR and unchanged-rate CFR clip an initial negative fraction
    // to zero, then preserve the one-frame cadence.
    timestamp=index=>origin+index-start;
    // Encoder deadline is an exact rational comparison, in addition to filter trim.
    if(outputDuration!==null)end=lowerBound(start,end,index=>timestamp(index)*base>=outputDuration*rate.num);
  }
  if(options.maxFrames!==null)end=min(end,start+options.maxFrames);
  const frames=end>start?end-start:0n,first=start;
  const copy=options.copy,inputSeekSet=options.inputSeekSet;
  // Native stream-info analysis buffers intervals plus the first packet, capped
  // by default probe bytes. Seeking flushes these zero-duration high-rate packets.
  const prefetched=min(total,min((5000000n+BigInt(options.frameBytes)-1n)/BigInt(options.frameBytes),rate.num<2000n*rate.den?41n:21n));
  return Object.freeze({start:first,frames,durationForFrame(index:bigint){if(typeof index!=='bigint'||index<0n||index>=frames)throw new ExecutionError('invalid-time','Raw video duration index outside selection');return copy&&!inputSeekSet&&rate.num>=1000n*rate.den&&first+index<prefetched?0n:1n;},ptsForFrame(index:bigint){if(typeof index!=='bigint'||index<0n||index>=frames)throw new ExecutionError('invalid-time','Raw video timestamp index outside selection');return timestamp(first+index);}});
}
