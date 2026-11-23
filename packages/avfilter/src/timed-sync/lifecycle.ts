import type {Rational} from '@edge-ffmpeg/avutil';
import {synchronizeTimedFrames} from './stream.js';
import type {Event} from './stream.js';
export type TimedSynchronizationOptions<T>=Parameters<typeof synchronizeTimedFrames<T>>[1];
type Output<T>=ReturnType<typeof synchronizeTimedFrames<T>> extends AsyncIterable<infer V>?V:never;
export interface Completion {readonly status:'eof'|'error'|'cancelled'|'closed';readonly error?:unknown;readonly secondaryErrors:readonly unknown[]}
export type TimedSynchronizationOutput<T>=Output<T>;
export interface TimedSynchronizationSource<T>{readonly timeBase:Rational;open(signal:AbortSignal):AsyncIterable<Event<T>>}
/** Sources must cooperate with the factory signal. */
export function createTimedSynchronization<T>(sources:readonly TimedSynchronizationSource<T>[],settings:TimedSynchronizationOptions<T>){
 const controller=new AbortController(),options={...settings,signal:controller.signal};
 let descriptors:typeof sources|undefined=sources.map(source=>({timeBase:{...source.timeBase},open:source.open.bind(source)}));
 const planned=synchronizeTimedFrames<T>(descriptors.map(source=>({timeBase:source.timeBase,events:{[Symbol.asyncIterator](){return source.open(controller.signal)[Symbol.asyncIterator]();}}})),options),timeBase=planned.timeBase,diagnostics=planned.diagnostics;
 let core:AsyncIterator<Output<T>>|undefined=planned[Symbol.asyncIterator](),busy=false,acquired=false,outcome:Completion|undefined,pending:Promise<void>|undefined,shutdown:Promise<void>|undefined,request:{status:'closed'|'cancelled';error:unknown}|undefined;
 let resolve!:(completion:Completion)=>void;const completion=new Promise<Completion>(done=>{resolve=done;});
 let detach:(()=>void)|undefined;
 const secondary=(primary:unknown,extra:readonly unknown[]=[],inputOffset=0)=>[...diagnostics.inputErrors.slice(inputOffset),...new Set([...diagnostics.cleanupErrors,...extra].filter(error=>error!==primary))];
 const settle=(value:Completion)=>{if(outcome)return;outcome=Object.freeze({...value,secondaryErrors:Object.freeze([...value.secondaryErrors])});descriptors=undefined;detach?.();detach=undefined;resolve(outcome);};
 const clean=async()=>{const current=core;core=undefined;try{await current?.return?.();return [] as unknown[];}catch(error){return [error];}};
 const stop=(status:'closed'|'cancelled',error:unknown)=>{if(outcome)return;if(!request)request={status,error};if(!controller.signal.aborted)controller.abort(error);if(!shutdown)shutdown=(async()=>{await pending;if(outcome)return;const errors=await clean();settle({status:request!.status,error:request!.error,secondaryErrors:secondary(request!.error,errors)});})();};
 const requested=()=>request;
 const iterator:AsyncIterator<Output<T>>={
  next(){if(busy)return Promise.reject(new Error('Concurrent timed synchronization reads'));if(outcome)return Promise.resolve({done:true as const,value:undefined});if(request)return (shutdown??Promise.resolve()).then(()=>({done:true as const,value:undefined}));busy=true;
   const task=(async():Promise<IteratorResult<Output<T>>>=>{try{
    controller.signal.throwIfAborted();if(!core)throw new Error('Timed synchronization already released');
    const next=await core.next();controller.signal.throwIfAborted();if(next.done)throw new Error('Timed synchronization ended without terminal event');
    if(next.value.kind==='end'){const errors=await clean();controller.signal.throwIfAborted();if(errors.length)throw errors[0];const upstream=next.value.inputErrors;settle({status:upstream.length?'error':'eof',...(upstream.length?{error:upstream[0]}:{}),secondaryErrors:secondary(upstream[0],[],1)});}
    return next;
   }catch(error){const errors=await clean(),upstream=diagnostics.inputErrors,cancellation=requested(),sourcePrimary=!cancellation&&!controller.signal.aborted&&upstream.length>0,primary=cancellation?cancellation.error:controller.signal.aborted?controller.signal.reason:sourcePrimary?upstream[0]:error;settle({status:requested()?.status??(controller.signal.aborted?'cancelled':'error'),error:primary,secondaryErrors:secondary(primary,[...(error!==primary?[error]:[]),...errors],sourcePrimary?1:0)});throw primary;}finally{busy=false;}})();pending=task.then(()=>{},()=>{});return task;
  },
  async return(){stop('closed',new Error('Timed synchronization closed'));await shutdown;return {done:true,value:undefined};}
 };
 if(settings.signal){const external=settings.signal,abort=()=>stop('cancelled',external.reason);if(external.aborted)abort();else{external.addEventListener('abort',abort,{once:true});detach=()=>external.removeEventListener('abort',abort);}}
 const acquire=()=>{if(acquired)throw new Error('Timed synchronization can only be acquired once');acquired=true;return iterator;};
 const assertSuccess=async()=>{const done=await completion;if(done.status!=='eof')throw done.error;return done;};
 return {timeBase,completion,assertSuccess,[Symbol.asyncIterator]:acquire,
  frameEvents():AsyncIterable<Extract<Output<T>,{kind:'frame'}>>{
   const input=acquire();let viewed=false;
   return {[Symbol.asyncIterator](){if(viewed)throw new Error('Timed frame view can only be acquired once');viewed=true;let reading=false;
    const reader=(async function*(){try{for(;;){const next=await input.next();if(next.done){await assertSuccess();return;}if(next.value.kind==='end'){await assertSuccess();return;}yield next.value;}}finally{await input.return?.();}})();
    return {async next(){if(reading)throw new Error('Concurrent timed frame view reads');reading=true;try{return await reader.next();}finally{reading=false;}},async return(){const closing=input.return?.();try{return await reader.return(undefined);}finally{await closing;}}};
   }};
  },
  async close(reason:unknown=new Error('Timed synchronization closed')){stop('closed',reason);await shutdown;return outcome!;}
 };

}
