import {snapshotFrameMetadata} from "@edge-ffmpeg/avutil";
// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped producer/FIFO integration based on fftools/ffmpeg_sched.c; see NOTICE.activation.
import {createQueuedActorDelivery} from "./queued-actor-delivery.js";
import type {LinkLease} from "@edge-ffmpeg/avfilter";
import type {createActorMultiInputDriver,ActorSourceEvent} from "@edge-ffmpeg/avfilter";
type Factory=(signal:AbortSignal)=>AsyncIterable<ActorSourceEvent>;
type Driver=ReturnType<typeof createActorMultiInputDriver>;
interface PhysicalInput {pads:number[];factory:Factory|undefined;iterator:AsyncIterator<ActorSourceEvent>|undefined;task:Promise<void>|undefined;enabled:boolean;ended:boolean;controller:AbortController;stop:{reason:unknown}|undefined;returning:Promise<void>|undefined;returned:boolean}
/** Bounded asynchronous raw-frame producers; complete native DTS rate control is not implemented. */
export function createScheduledInputPump<Control=never>(driver:Driver,sources:readonly Factory[],bindings:readonly number[],options:{maxBytes:number;maxFrameBytes:number;maxEvents:number;signal?:AbortSignal;control?(message:Control,signal:AbortSignal):void|Promise<void>}){
 const settings={...options},count=driver.inputCount,ids=[...bindings];
 if(sources.length!==count||ids.length!==count||ids.some(id=>!Number.isSafeInteger(id)||id<0)||![settings.maxBytes,settings.maxFrameBytes,settings.maxEvents].every(n=>Number.isSafeInteger(n)&&n>0)||settings.maxFrameBytes>settings.maxBytes)throw new Error('Invalid scheduled physical input configuration');
 const groups=new Map<number,PhysicalInput>();
 for(const [pad,id]of ids.entries()){let group=groups.get(id);if(!group){group={pads:[],factory:sources[pad],iterator:undefined,task:undefined,enabled:false,ended:false,controller:new AbortController(),stop:undefined,returning:undefined,returned:false};groups.set(id,group);}group.pads.push(pad);}
 const controller=new AbortController(),errors:unknown[]=[],cleanup:unknown[]=[],operations=new Set<Promise<unknown>>(),waiters=new Set<()=>void>();
 let closing=false,busy=false,reservedBytes=0,attempts=0,events=0,disposal:Promise<void>|undefined;
 const observe=(error:unknown,isCleanup=false)=>{if(!errors.some(item=>Object.is(item,error)))errors.push(error);if(isCleanup&&!cleanup.some(item=>Object.is(item,error)))cleanup.push(error);};
 const fail=(error:unknown)=>{observe(error);if(!controller.signal.aborted)controller.abort(errors[0]);};
 const abortGroups=()=>{for(const group of groups.values())if(!group.controller.signal.aborted)group.controller.abort(controller.signal.reason);};
 controller.signal.addEventListener('abort',abortGroups,{once:true});
 const externalAbort=()=>fail(settings.signal!.reason);
 const track=<T>(task:Promise<T>)=>{operations.add(task);void task.then(()=>operations.delete(task),()=>operations.delete(task));return task;};
 const notify=()=>{for(const wake of [...waiters])wake();};
 const changed=()=>new Promise<void>((resolve,reject)=>{
  if(controller.signal.aborted){reject(controller.signal.reason);return;}
  if(waiters.size>=groups.size)throw new Error('Physical producer waiter budget exceeded');
  const clear=()=>{waiters.delete(wake);controller.signal.removeEventListener('abort',abort);},wake=()=>{clear();resolve();},abort=()=>{clear();reject(controller.signal.reason);};
  waiters.add(wake);controller.signal.addEventListener('abort',abort,{once:true});
 });
 const returnGroup=(group:PhysicalInput)=>group.returning??=(async()=>{const iterator=group.iterator;group.iterator=undefined;group.factory=undefined;try{await iterator?.return?.();}catch(error){observe(error,true);fail(error);throw error;}finally{group.returned=true;}})();
 const inputClosed=Array<boolean>(count).fill(false);
 const delivery=createQueuedActorDelivery<Control>(driver,{maxFrames:2,maxBytes:settings.maxBytes,push:true,...(settings.control?{control:settings.control}:{})});
 const finishClosedGroup=(group:PhysicalInput)=>{group.ended=true;if(!closing)for(const pad of group.pads)delivery.finishInput(pad);};
 const syncClosedInputs=()=>{if(closing)return;for(const [pad,closed]of driver.closedInputs.entries())if(closed&&!inputClosed[pad]){inputClosed[pad]=true;delivery.closeInput(pad);}for(const group of groups.values())if(group.pads.every(pad=>inputClosed[pad])){if(!group.stop){group.stop={reason:new Error('Physical input no longer needed')};if(!group.controller.signal.aborted)group.controller.abort(group.stop.reason);}if(!group.task&&!group.ended){finishClosedGroup(group);group.factory=undefined;}}notify();};
 const start=(group:PhysicalInput)=>{
  if(group.task||group.ended)return;
  group.task=track((async()=>{
   try{for(;;){
    while(!group.enabled||reservedBytes>settings.maxBytes-settings.maxFrameBytes){if(group.pads.every(pad=>inputClosed[pad])){controller.signal.throwIfAborted();finishClosedGroup(group);return;}await changed();}
    controller.signal.throwIfAborted();
    if(group.pads.every(pad=>(delivery.state.finished[pad]!&2)!==0)){finishClosedGroup(group);return;}
    if(attempts>=settings.maxEvents)throw new Error('Physical source event budget exceeded');
    attempts++;reservedBytes+=settings.maxFrameBytes;
    let retained=false,released=false;
    const release=()=>{if(released)return;released=true;reservedBytes-=settings.maxFrameBytes;notify();};
    try{
     if(!group.iterator){const factory=group.factory!;group.factory=undefined;group.iterator=factory(group.controller.signal)[Symbol.asyncIterator]();}
     const next=await group.iterator.next();group.controller.signal.throwIfAborted();controller.signal.throwIfAborted();
     if(next.done)throw new Error('Physical input ended without explicit status');
     events++;const produced=next.value;
     const bytes=produced.kind==='frame'?'frame' in produced?produced.frame.planes.reduce((sum,plane)=>sum+plane.byteLength,0):1:0;
     if(bytes>settings.maxFrameBytes)throw new Error('Physical frame exceeds reserved byte budget');
     // A producer may reuse its frame storage on the next read. Own one copy
     // per physical event before fanout, keeping references stable in the FIFO.
     const event:ActorSourceEvent=produced.kind==='frame'&&'frame' in produced?{...produced,frame:{...produced.frame,planes:produced.frame.planes.map(plane=>new Uint8Array(plane)),linesizes:[...produced.frame.linesizes],pts:produced.frame.pts?{...produced.frame.pts,timeBase:{...produced.frame.pts.timeBase}}:null,metadata:snapshotFrameMetadata(produced.frame.metadata)}}:{...produced};
     if(event.kind==='end'&&event.status==='error')observe(event.error);
     // submit validates synchronously before adopting the physical reservation.
     const sent=delivery.submit(group.pads,{value:event,bytes,release},group.controller.signal);retained=true;
     await sent;controller.signal.throwIfAborted();
     if(event.kind==='end'){group.ended=true;for(const pad of group.pads)delivery.finishInput(pad);return;}
    }finally{if(!retained)release();}
   }}catch(error){if(group.stop&&Object.is(error,group.stop.reason))finishClosedGroup(group);else if(!(closing&&Object.is(error,controller.signal.reason)))fail(error);}finally{await returnGroup(group);}
  })());
 };
 if(settings.signal?.aborted)externalAbort();else settings.signal?.addEventListener('abort',externalAbort,{once:true});
 return {
  syncClosedInputs,
  submitControl(lease:LinkLease<Control>,signal?:AbortSignal){return delivery.submitControl(lease,signal);},
  get failures(){return Object.freeze([...errors]);},get cleanupErrors(){return Object.freeze([...cleanup,...delivery.cleanupErrors]);},get sourceEvents(){return events;},get queued(){return delivery.state;},
  snapshot(){return Object.freeze({reservedBytes,attempts,events,waiters:waiters.size,groups:Object.freeze([...groups.values()].map(group=>Object.freeze({pads:Object.freeze([...group.pads]),started:!!group.task,enabled:group.enabled,ended:group.ended,cancelled:group.controller.signal.aborted,returned:group.returned})))});},
  advance(requested:number|null){
   if(busy)throw new Error('Concurrent scheduled input admission');
   if(closing)return Promise.resolve(false);
   if(requested!==null&&(!Number.isInteger(requested)||requested<0||requested>=count))throw new Error('Invalid requested input');
   busy=true;
   return track((async()=>{try{
    controller.signal.throwIfAborted();
    syncClosedInputs();
    if(inputClosed.every(Boolean))return false;
    if(requested!==null&&inputClosed[requested]&&delivery.state.streams.length===0)return false;
    const wanted=requested===null?undefined:groups.get(ids[requested]!);
    for(const group of groups.values())group.enabled=group===wanted;
    if(wanted?.ended&&delivery.state.streams.length===0&&[...groups.values()].some(group=>!group.ended))throw new Error('Requested physical input is already finished');
    if(wanted)start(wanted);notify();
    const result=await delivery.deliverScheduled(requested,controller.signal);
    controller.signal.throwIfAborted();
    if(result.code===-541478725&&result.stream>=0){inputClosed[result.stream]=true;delivery.closeInput(result.stream);}
    syncClosedInputs();
    return 'control' in result&&result.control?'control' as const:result.code===0;
   }catch(error){if(closing&&Object.is(error,controller.signal.reason))return false;fail(error);throw errors[0];}finally{busy=false;}})());
  },
  close(reason:unknown=new Error('Scheduled physical input pump closed')){return disposal??=(async()=>{
   closing=true;if(!controller.signal.aborted)controller.abort(reason);
   const stopping=delivery.close(reason);void stopping.catch(()=>{});
   await Promise.allSettled([...operations]);
   try{await stopping;}catch(error){if(!errors.some(item=>Object.is(item,error)))observe(error,true);}
   for(const group of groups.values()){
    try{await returnGroup(group);}catch(error){observe(error,true);}
    group.iterator=undefined;group.factory=undefined;group.task=undefined;
   }
   settings.signal?.removeEventListener('abort',externalAbort);controller.signal.removeEventListener('abort',abortGroups);
   for(const error of delivery.cleanupErrors)observe(error,true);
   if(reservedBytes!==0)observe(new Error('Physical reservations survived shutdown'),true);
   if(errors.length)throw errors[0];
  })();}
 };
}
