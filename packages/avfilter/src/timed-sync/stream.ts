// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapts pinned libavfilter/framesync.c, Copyright (c) 2013 Nicolas George.
import {rescaleTimestamp} from './int64.js';
import type {Rational,Timestamp} from '@edge-ffmpeg/avutil';
import {synchronizationTimeBase} from '../frame-sync.js';
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
export type Event<T>={kind:'frame';value:T}|({kind:'end';pts:bigint|null}&({status:'eof'}|{status:'error';error:unknown}));
export function synchronizeTimedFrames<T>(sources:readonly {timeBase:Rational;events:AsyncIterable<Event<T>>}[],options:{shortest:boolean;maxResidentBytes:number;maxPendingFrames?:number;maxOperatorSteps?:number;checkpointEvery?:number;checkpoint?:(progress:{operatorSteps:number;signal:AbortSignal|undefined})=>Promise<void>;signal?:AbortSignal;timestamp(value:T):Timestamp|null;retain(value:T,available:number):{value:T;bytes:number;release():void}}){
 options={...options};const descriptors=sources.map(source=>({...source,timeBase:Object.freeze({...source.timeBase})}));
 if(typeof options.timestamp!=='function'||typeof options.retain!=='function'||options.checkpoint!==undefined&&typeof options.checkpoint!=='function')throw new Error('Invalid timed synchronization callbacks');
 if(!Number.isSafeInteger(options.maxResidentBytes)||options.maxResidentBytes<1)throw new Error('Invalid timed sync budget');
 if(options.maxPendingFrames!==undefined&&(!Number.isSafeInteger(options.maxPendingFrames)||options.maxPendingFrames<2*descriptors.length)||options.maxOperatorSteps!==undefined&&(!Number.isSafeInteger(options.maxOperatorSteps)||options.maxOperatorSteps<1)||options.checkpointEvery!==undefined&&(!Number.isSafeInteger(options.checkpointEvery)||options.checkpointEvery<1))throw new Error('Invalid timed sync work or pending budget');
 const timeBase=synchronizationTimeBase(descriptors.map(source=>source.timeBase));
 const inputErrors:unknown[]=[],cleanupErrors:unknown[]=[];let acquired=false;
 const diagnostics=Object.freeze({get inputErrors(){return Object.freeze([...inputErrors]);},get cleanupErrors(){return Object.freeze([...cleanupErrors]);}});
 const iterate=async function*(){
  type Lease=ReturnType<typeof options.retain>;
  const inputs=descriptors.map(source=>({source,iterator:null as AsyncIterator<Event<T>>|null,state:'bof' as 'bof'|'run'|'eof',active:true,current:null as {lease:Lease;pts:bigint}|null,next:null as {lease:Lease|null;pts:bigint}|null,linkPts:null as bigint|null}));
  const leases=new Set<Lease>(),errors=inputErrors;let resident=0,raw:bigint|null=null,outputPts:bigint|null=null,ended=false,failed=false;
  let operatorSteps=0;const advance=async()=>{options.signal?.throwIfAborted();if(operatorSteps>=(options.maxOperatorSteps??1000000))throw new Error('Timed synchronization operator budget exceeded');operatorSteps++;if(options.checkpoint&&operatorSteps%(options.checkpointEvery??1)===0)await options.checkpoint(Object.freeze({operatorSteps,signal:options.signal}));options.signal?.throwIfAborted();};
  const known=(value:bigint|null)=>{if(value===null||value===MIN)return null;if(typeof value!=='bigint'||value<MIN||value>MAX)throw new Error('Timed source PTS outside supported signed64 range');return value;};
  const release=(lease:Lease)=>{leases.delete(lease);resident-=lease.bytes;try{lease.release();}catch(error){cleanupErrors.push(error);throw error;}};
  let cleanup:Promise<unknown[]>|undefined;const clean=()=>cleanup??=(async()=>{const failures:unknown[]=[];for(const lease of leases)try{lease.release();}catch(error){failures.push(error);}leases.clear();for(const input of inputs)try{await input.iterator?.return?.();}catch(error){failures.push(error);}cleanupErrors.push(...failures);return failures;})();
  try{for(const input of inputs){options.signal?.throwIfAborted();input.iterator=input.source.events[Symbol.asyncIterator]();}for(;;){await advance();
   for(const input of inputs){if(input.next||input.state==='eof')continue;
    await advance();const result=await input.iterator!.next();options.signal?.throwIfAborted();if(result.done)throw new Error('Missing explicit timed input status');const event=result.value;
    if(event.kind==='frame'){
     const stamp=options.timestamp(event.value);if(stamp&&(typeof stamp.value!=='bigint'||typeof stamp.timeBase.num!=='bigint'||typeof stamp.timeBase.den!=='bigint'||stamp.timeBase.num<=0n||stamp.timeBase.den<=0n||stamp.timeBase.num*input.source.timeBase.den!==input.source.timeBase.num*stamp.timeBase.den))throw new Error('Changing timed input clock');
     const original=known(stamp?.value??null);if(original!==null)input.linkPts=original;
     const pts=original===null?MIN:rescaleTimestamp(original,input.source.timeBase,timeBase);const lease=options.retain(event.value,options.maxResidentBytes-resident);
     if(!Number.isSafeInteger(lease.bytes)||lease.bytes<0||lease.bytes>options.maxResidentBytes-resident||leases.has(lease)){if(!leases.has(lease))lease.release();throw new Error('Timed sync lease budget');}
     leases.add(lease);resident+=lease.bytes;input.next={lease,pts};
    }else{
     if(event.kind!=='end'||(event.status!=='eof'&&event.status!=='error'))throw new Error('Invalid timed input event');
     const statusPts=known(event.pts);if(statusPts!==null)input.linkPts=statusPts;
     input.active=false;if(event.status==='error')errors.push(event.error);
     if(inputs.every(input=>!input.active)){ended=true;raw=event.status==='eof'?input.linkPts:null;}
     input.next={lease:null,pts:input.state!=='run'||!options.shortest?MAX:input.current!.pts+1n};
    }
   }
   if(ended)break;
   const point=inputs.reduce((value,input)=>input.next&&input.next.pts<value?input.next.pts:value,MAX);
   if(point===MAX){raw=null;break;}
   let ready=false;
   for(const input of inputs)if(input.next?.pts===point){if(input.current)release(input.current.lease);const next=input.next;input.next=null;input.current=next.lease?{lease:next.lease,pts:next.pts}:null;input.state=next.lease?'run':'eof';if(next.lease&&input.active)ready=true;if(input.state==='eof'&&options.shortest){ended=true;raw=null;}}
   if(ended)break;
   if(ready&&inputs.every(input=>input.state!=='bof')){outputPts=point===MIN?MIN+1n:point;yield Object.freeze({kind:'frame' as const,pts:Object.freeze({value:point,timeBase}),values:Object.freeze(inputs.map(input=>input.current!.lease.value))});}
  }
  const failures=await clean();if(failures.length)throw failures[0];
  yield Object.freeze({kind:'end' as const,status:'eof' as const,rawPts:raw,pts:raw??outputPts,inputPts:Object.freeze(inputs.map(input=>input.linkPts)),inputErrors:Object.freeze([...errors])});
  }catch(error){failed=true;throw error;}finally{
   const failures=await clean();if(!failed&&failures.length)throw failures[0];
  }
 };
 return {timeBase,diagnostics,[Symbol.asyncIterator](){if(acquired)throw new Error('Timed synchronization can only be acquired once');acquired=true;return iterate();}};
}
