import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createVideoPtsTransform} from './state.js';
export type FrameEvent={readonly kind:'frame';readonly frame:VideoFrameData;readonly duration:bigint;readonly interlaced?:boolean};
export type SourceEnd={readonly kind:'end';readonly pts:bigint|null}&({readonly status:'eof'}|{readonly status:'error';readonly error:unknown});
export type SourceEvent=FrameEvent|SourceEnd;
export interface Completion {readonly status:'eof'|'error'|'cancelled'|'closed';readonly pts:bigint|null;readonly rawPts:bigint|null;readonly inputPts:bigint|null;readonly error?:unknown;readonly secondaryErrors:readonly unknown[]}
export type OutputEnd={readonly kind:'end'}&Completion;
export type OutputEvent=FrameEvent|OutputEnd;
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
function known(value:bigint|null):bigint|null{if(value===null||value===MIN)return null;if(typeof value!=='bigint'||value<MIN||value>MAX)throw new Error('Timed stream timestamp exceeds signed64');return value;}
/** Pull-only timestamp stage. Source factories must cooperate with their AbortSignal. */
export function createSetptsStream(source:(signal:AbortSignal)=>AsyncIterable<SourceEvent>,options:Parameters<typeof createVideoPtsTransform>[0]&{maxFrameBytes:number}){
 const settings={...options,timeBase:{...options.timeBase},frameRate:{...options.frameRate}};
 if(!Number.isSafeInteger(settings.maxFrameBytes)||settings.maxFrameBytes<1)throw new Error('Invalid timed frame payload bound');
 const transform=createVideoPtsTransform(settings),controller=new AbortController();
 let openSource:typeof source|undefined=source;
 let iterator:AsyncIterator<SourceEvent>|undefined,sourceDone=false,opened=false,iteratorAcquired=false,busy=false;
 let readDone:Promise<void>|undefined,releaseRead:(()=>void)|undefined,cleanup:Promise<readonly unknown[]>|undefined;
 let outcome:Completion|undefined,request:{status:'closed'|'cancelled';error:unknown}|undefined,shutdown:Promise<void>|undefined;
 let lastInput:bigint|null=null,lastOutput:bigint|null=null,detach:(()=>void)|undefined;
 let resolveCompletion!:(value:Completion)=>void;
 const completion=new Promise<Completion>(resolve=>{resolveCompletion=resolve;});
 const settle=(value:Completion)=>{if(outcome)return;outcome=Object.freeze({...value,secondaryErrors:Object.freeze([...value.secondaryErrors])});detach?.();detach=undefined;resolveCompletion(outcome);};
 const clean=()=>{if(!cleanup)cleanup=(async()=>{const errors:unknown[]=[],current=iterator;iterator=undefined;openSource=undefined;if(current&&!sourceDone)try{await current.return?.();}catch(error){errors.push(error);}sourceDone=true;return errors;})();return cleanup;};
 const terminate=()=>{if(!shutdown)shutdown=(async()=>{if(readDone)await readDone;if(outcome)return;const errors=await clean();settle({status:request?.status??'closed',pts:lastOutput,rawPts:null,inputPts:lastInput,error:request?.error,secondaryErrors:errors});})();return shutdown;};
 const stop=(status:'closed'|'cancelled',error:unknown)=>{if(outcome)return;if(!request)request={status,error};if(!controller.signal.aborted)controller.abort(error);void terminate().catch(failure=>settle({status:'error',pts:lastOutput,rawPts:null,inputPts:lastInput,error:failure,secondaryErrors:[]}));};
 const requested=()=>request;
 const output:AsyncIterator<OutputEvent>={
  async next(){
   if(busy)throw new Error('Concurrent timed stream reads are unsupported');
   if(outcome)return {done:true,value:undefined};
   if(request){await terminate();return {done:true,value:undefined};}
   busy=true;readDone=new Promise(resolve=>{releaseRead=resolve;});
   try{
    controller.signal.throwIfAborted();
    if(!iterator){const factory=openSource;if(!factory)throw new Error('Timed source is already released');openSource=undefined;iterator=factory(controller.signal)[Symbol.asyncIterator]();}
    const result=await iterator.next();controller.signal.throwIfAborted();
    if(result.done){sourceDone=true;throw new Error('Timed source ended without an explicit status');}
    const event=result.value;
    if(event.kind==='frame'){
     const stamp=event.frame.pts;
     if(stamp&&(stamp.timeBase.num!==transform.timeBase.num||stamp.timeBase.den!==transform.timeBase.den))throw new Error('Timed frame time base differs from link');
     if(!Array.isArray(event.frame.planes)||event.frame.planes.length<1||event.frame.planes.length>8)throw new Error('Invalid timed frame plane count');
     let bytes=0;for(const plane of event.frame.planes){if(!(plane instanceof Uint8Array))throw new Error('Invalid timed frame plane');bytes+=plane.byteLength;if(bytes>settings.maxFrameBytes)throw new Error('Timed frame payload exceeds bound');}
     const input=known(stamp?.value??null),changed=transform.process({pts:input,duration:event.duration,interlaced:event.interlaced??false});
     if(input!==null)lastInput=input;if(changed.pts!==null)lastOutput=changed.pts;
     const frame={...event.frame,metadata:{...event.frame.metadata},pts:changed.pts===null?null:{value:changed.pts,timeBase:transform.timeBase}};
     return {done:false,value:{...event,frame,duration:changed.duration}};
    }
    if(event.kind!=='end'||(event.status!=='eof'&&event.status!=='error'))throw new Error('Invalid timed stream status');
    const input=known(event.pts)??lastInput;let raw:bigint|null=null,transformationError:unknown,failed=false;
    try{raw=transform.finish(input);}catch(error){failed=true;transformationError=error;}
    const errors=await clean();controller.signal.throwIfAborted();
    if(failed&&event.status==='eof')throw transformationError;
    if(errors.length&&event.status==='eof')throw errors[0];
    const terminal:Completion={status:event.status,pts:raw??lastOutput,rawPts:raw,inputPts:input,...(event.status==='error'?{error:event.error}:{}),secondaryErrors:[...(failed?[transformationError]:[]),...errors]};
    settle(terminal);return {done:false,value:{kind:'end',...outcome!}};
   }catch(error){const errors=await clean();settle({status:requested()?.status??(controller.signal.aborted?'cancelled':'error'),pts:lastOutput,rawPts:null,inputPts:lastInput,error,secondaryErrors:errors.filter(secondary=>secondary!==error)});throw error;}
   finally{busy=false;releaseRead?.();readDone=undefined;releaseRead=undefined;}
  },
  async return(){stop('closed',new Error('Timed stream closed by consumer'));await terminate();return {done:true,value:undefined};}
 };
 const stream={timeBase:transform.timeBase,frameRate:transform.frameRate,completion,
  open(signal?:AbortSignal):AsyncIterable<OutputEvent>{if(opened)throw new Error('Timed output can only be acquired once');if(outcome||request)throw new Error('Timed output is already closed');opened=true;if(signal){const abort=()=>stop('cancelled',signal.reason);if(signal.aborted)abort();else{signal.addEventListener('abort',abort,{once:true});detach=()=>signal.removeEventListener('abort',abort);}}return {[Symbol.asyncIterator](){if(iteratorAcquired)throw new Error('Timed output iterator can only be acquired once');iteratorAcquired=true;return output;}};},
  async close(reason:unknown=new Error('Timed stream closed')){stop('closed',reason);await terminate();return outcome!;},
  command(expression:string){if(outcome||request)throw new Error('Timed output is already closed');if(busy)throw new Error('Commands require a frame boundary');transform.command(expression);}
 };
 return {...stream,
  /** Frame-only sink view: terminal errors throw before a sink can finalize output. */
  openFrames(signal?:AbortSignal):AsyncIterable<FrameEvent>{
   const events=stream.open(signal);let acquired=false;
   return {[Symbol.asyncIterator]():AsyncIterator<FrameEvent>{
    if(acquired)throw new Error('Timed frame iterator can only be acquired once');acquired=true;
    const input=events[Symbol.asyncIterator]();let finished=false,reading=false;
    const reader=(async function*(){try{for(;;){const next=await input.next();
     if(next.done)throw (await completion).error??new Error('Timed stream closed before EOF');
     const event=next.value;if(event.kind==='frame'){yield event;continue;}
     const terminal=await completion;
     if(event.status!=='eof'||terminal.status!=='eof')throw terminal.error??new Error('Timed stream failed before EOF');
     finished=true;return;
    }}finally{if(!finished)await input.return?.();}})();
    return {async next(){if(reading)throw new Error('Concurrent timed frame reads are unsupported');reading=true;try{return await reader.next();}finally{reading=false;}},async return(){const closing=input.return?.();try{return await reader.return(undefined);}finally{await closing;}}};
   }};
  }
 };
}
