// SPDX-License-Identifier: LGPL-2.1-or-later
// State transitions and time-base selection adapt pinned libavfilter/framesync.c
// Copyright (c) 2013 Nicolas George; av_gcd_q from libavutil/rational.c,
// Copyright (c) 2003 Michael Niedermayer <michaelni@gmx.at>.
import {rescale} from '@edge-ffmpeg/avutil';
import type {Rational,Timestamp} from '@edge-ffmpeg/avutil';
const MAX=(1n<<63n)-1n,MIN=-(1n<<63n);
const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a;
export function synchronizationTimeBase(bases:readonly Rational[]):Readonly<Rational>{
 if(bases.length<2||bases.length>32)throw new Error('Synchronization requires 2..32 inputs');
 const declared=bases.map(base=>{if(typeof base.num!=='bigint'||typeof base.den!=='bigint'||base.num<=0n||base.den<=0n||base.num>2147483647n||base.den>2147483647n)throw new Error('Unsupported synchronization time base');return {num:base.num,den:base.den};});
 let value=declared[0]!;for(const next of declared.slice(1)){const denominator=value.den/gcd(value.den,next.den)*next.den;value=denominator<500000n?{num:gcd(value.num,next.num),den:denominator}:{num:1n,den:1000000n};}
 return Object.freeze(value);
}
export interface SynchronizationLease<T>{readonly value:T;readonly bytes:number;release():void}
export interface SynchronizationSource<T>{readonly frames:AsyncIterable<T>;readonly timeBase:Rational}
export interface SynchronizationOptions<T>{readonly shortest?:boolean;readonly maxPendingFrames:number;readonly maxResidentBytes:number;readonly signal?:AbortSignal;timestamp(frame:T):Timestamp|null;retain(frame:T,availableBytes:number):SynchronizationLease<T>}
interface Held<T>{lease:SynchronizationLease<T>;pts:bigint}
interface Input<T>{iterator:AsyncIterator<T>;base:Rational;current:Held<T>|null;next:Held<T>|null;eof:boolean;done:boolean}
/** Bounded, cooperative all-input synchronization with stop-before/repeat-after semantics.
 * retain must reserve before allocation and release exactly once; input payload ownership
 * is delegated explicitly rather than assuming that an async producer never reuses storage.
 */
export function synchronizeFrames<T>(sources:readonly SynchronizationSource<T>[],options:SynchronizationOptions<T>):AsyncIterable<{readonly pts:Timestamp;readonly frames:readonly T[]}>{
 const descriptors=Object.freeze(sources.map(source=>Object.freeze({...source}))),bases=descriptors.map(source=>Object.freeze({...source.timeBase})),timeBase=synchronizationTimeBase(bases),snapshot={...options};
 if(typeof snapshot.timestamp!=='function'||typeof snapshot.retain!=='function')throw new Error('Missing synchronization ownership callbacks');
 if(!Number.isSafeInteger(snapshot.maxPendingFrames)||snapshot.maxPendingFrames<2*descriptors.length||!Number.isSafeInteger(snapshot.maxResidentBytes)||snapshot.maxResidentBytes<1)throw new Error('Invalid synchronization budget');
 return {async *[Symbol.asyncIterator](){
  snapshot.signal?.throwIfAborted();const inputs:Input<T>[]=[],leases=new Set<SynchronizationLease<T>>();let resident=0,primary=false;
  const release=(held:Held<T>|null)=>{if(held){leases.delete(held.lease);resident-=held.lease.bytes;held.lease.release();}};
  const next=async(input:Input<T>)=>{
   if(input.next||input.eof)return;snapshot.signal?.throwIfAborted();const item=await input.iterator.next();snapshot.signal?.throwIfAborted();
   if(item.done){input.eof=true;input.done=true;return;}
   const stamp=snapshot.timestamp(item.value);if(stamp&&(typeof stamp.value!=='bigint'||stamp.value<MIN||stamp.value>=MAX||typeof stamp.timeBase.num!=='bigint'||typeof stamp.timeBase.den!=='bigint'||stamp.timeBase.num<=0n||stamp.timeBase.den<=0n||stamp.timeBase.num*input.base.den!==input.base.num*stamp.timeBase.den))throw new Error('Invalid or changing synchronization timestamp');
   // Native AV_ROUND_PASS_MINMAX preserves AV_NOPTS through synchronization.
   const pts=!stamp||stamp.value===MIN?MIN:rescale(stamp.value,input.base,timeBase);if(pts<MIN||pts>=MAX)throw new Error('Synchronization timestamp exceeds signed64 domain');
   const available=snapshot.maxResidentBytes-resident,lease=snapshot.retain(item.value,available);
   if(!Number.isSafeInteger(lease.bytes)||lease.bytes<0||lease.bytes>available||leases.has(lease)){if(!leases.has(lease))lease.release();throw new Error('Invalid synchronization lease or resident budget');}
   leases.add(lease);resident+=lease.bytes;input.next={lease,pts};
  };
  try{
   for(const [index,source]of descriptors.entries())inputs.push({iterator:source.frames[Symbol.asyncIterator](),base:bases[index]!,current:null,next:null,eof:false,done:false});
   for(;;){
    snapshot.signal?.throwIfAborted();for(const input of inputs)await next(input);
    // A source with no first frame can never pass EXT_STOP at BOF.
    if(inputs.some(input=>input.eof&&!input.current&&!input.next))return;
    const active=inputs.filter(input=>input.next);if(!active.length)return;
    const event=active.reduce((pts,input)=>input.next!.pts<pts?input.next!.pts:pts,MAX);
    if(snapshot.shortest)for(const input of inputs)if(input.eof&&input.current&&input.current.pts+1n<=event)return;
    for(const input of inputs)if(input.next?.pts===event){const old=input.current;input.current=input.next;input.next=null;release(old);}
    if(inputs.some(input=>!input.current))continue;
    // All selected current frames are held until subsequent advancement. Consumers
    // borrow them only until their next iterator request; callers retain explicitly.
    yield Object.freeze({pts:Object.freeze({value:event,timeBase}),frames:Object.freeze(inputs.map(input=>input.current!.lease.value))});
   }
  }catch(error){primary=true;throw error;}
  finally{
   let cleanup:unknown;for(const lease of leases)try{lease.release();}catch(error){cleanup??=error;}leases.clear();resident=0;
   for(const input of inputs)if(!input.done)try{await input.iterator.return?.();}catch(error){cleanup??=error;}
   if(!primary&&cleanup!==undefined)throw cleanup;
  }
 }};
}
