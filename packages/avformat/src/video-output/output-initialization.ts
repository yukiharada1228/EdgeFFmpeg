import type {SyncFrame} from './sync.js';
import {rawVideoOutputClock} from './output-clock.js';
import {createVideoTimeTrim} from './video-trim.js';
type ClockOptions=Parameters<typeof rawVideoOutputClock>[0];
/** Prime at most one admitted frame; EOF uses configure_filtergraph's tentative clock. */
export async function initializeVideoOutput<T>(source:AsyncIterable<SyncFrame<T>>,options:ClockOptions&{readonly emptyFilterTimeBase?:()=>ClockOptions['filterTimeBase'];readonly startUs?:bigint;readonly durationUs?:bigint|null;readonly signal?:AbortSignal}){
 const snapshot={...options,filterTimeBase:Object.freeze({...options.filterTimeBase}),sinkFrameRate:Object.freeze({...options.sinkFrameRate}),...(options.outputMaxFrameRate?{outputMaxFrameRate:Object.freeze({...options.outputMaxFrameRate})}:{}),...(options.outputFrameRate?{outputFrameRate:Object.freeze({...options.outputFrameRate})}:{}),...(options.demuxTimeBase?{demuxTimeBase:Object.freeze({...options.demuxTimeBase})}:{}),...(typeof options.encoderTimeBase==='object'?{encoderTimeBase:Object.freeze({...options.encoderTimeBase})}:{})},signal=options.signal;
 signal?.throwIfAborted();const trim=createVideoTimeTrim(snapshot.filterTimeBase,{startUs:options.startUs??0n,durationUs:options.durationUs??null}),iterator=source[Symbol.asyncIterator]();let first:SyncFrame<T>|null=null,done=false,released=false,acquired=false,closed=false;
 const release=async()=>{if(released)return;released=true;first=null;if(!done)await iterator.return?.();};
 const read=async():Promise<SyncFrame<T>|null>=>{while(!done){signal?.throwIfAborted();const next=await iterator.next();signal?.throwIfAborted();if(next.done){done=true;return null;}const frame=next.value;if(frame.pts.timeBase.num!==snapshot.filterTimeBase.num||frame.pts.timeBase.den!==snapshot.filterTimeBase.den)throw new Error('Unplanned filter clock');if(trim.accept(frame.pts.value))return frame;if(trim.eof)return null;}return null;};
 let clock:ReturnType<typeof rawVideoOutputClock>;
 try{first=await read();clock=first?rawVideoOutputClock(snapshot):Object.freeze({mode:snapshot.mode,frameRate:Object.freeze({...snapshot.outputFrameRate??(snapshot.sinkFrameRate.num>0n&&snapshot.sinkFrameRate.den>0n?snapshot.sinkFrameRate:{num:0n,den:0n})}),timeBase:Object.freeze({...options.emptyFilterTimeBase?.()??snapshot.filterTimeBase}),fallback:false});if(!first)await release();}
 catch(error){try{await release();}catch{}throw error;}
 let stream:AsyncGenerator<SyncFrame<T>>|undefined,closing:Promise<void>|undefined;
 const close=():Promise<void>=>{if(closing)return closing;closed=true;closing=(async()=>{let failed=false;try{await stream?.return(undefined);}catch(error){failed=true;throw error;}finally{try{await release();}catch(error){if(!failed)throw error;}}})();return closing;};
 const frames:AsyncIterable<SyncFrame<T>>={ [Symbol.asyncIterator](){if(acquired||closed)throw new Error('Initialized output already acquired or closed');acquired=true;const iterator=(async function*(){let failed=false;try{signal?.throwIfAborted();if(first){const value=first;first=null;yield value;}while(!done){const frame=await read();if(frame===null)break;yield frame;}}catch(error){failed=true;throw error;}finally{try{await release();}catch(error){if(!failed)throw error;}}})();stream=iterator;let busy=false;
  return {async next(){if(busy)throw new Error('Concurrent initialized output reads are unsupported');if(closed)return {done:true,value:undefined};busy=true;try{signal?.throwIfAborted();const result=await iterator.next();signal?.throwIfAborted();if(result.done)closed=true;return result;}catch(error){try{await close();}catch{}throw error;}finally{busy=false;}},async return(){await close();return {done:true,value:undefined};}};
 }};
 return Object.freeze({clock,hadFilteredFrame:first!==null,frames,close});
}
