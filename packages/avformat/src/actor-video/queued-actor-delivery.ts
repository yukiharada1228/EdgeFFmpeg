// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped scheduler/FIFO integration; see NOTICE.activation.
import {createSchedulerReceiver} from "./scheduler-receive.js";
import {createThreadFrameQueue} from "./thread-frame-queue.js";
import type {createActorMultiInputDriver,ActorSourceEvent} from "@edge-ffmpeg/avfilter";
import type {LinkLease} from "@edge-ffmpeg/avfilter";
type Driver=ReturnType<typeof createActorMultiInputDriver>;
/** Own decoded events while delivering their destination references in arrival order. */
export function createQueuedActorDelivery<Control=never>(driver:Driver,options:{maxFrames:number;maxBytes:number;maxWaiters?:number;push?:boolean;control?(message:Control,signal:AbortSignal):void|Promise<void>;scheduler?:{update(input:number,signal?:AbortSignal):void|Promise<void>;wait(signal?:AbortSignal):Promise<boolean>}}){
 type Message={kind:'input';value:ActorSourceEvent}|{kind:'control';value:Control};
 const settings={...options,...(options.scheduler?{scheduler:{...options.scheduler}}:{})},count=driver.inputCount,queue=createThreadFrameQueue<Message>(count+1,settings),controller=new AbortController(),operations=new Set<Promise<unknown>>(),errors:unknown[]=[],cleanupErrors:unknown[]=[],sendDone=Array<boolean>(count).fill(false),receiveDone=Array<boolean>(count).fill(false);let closing=false,busy=false,disposal:Promise<void>|undefined;
 const observe=(error:unknown,cleanup=false)=>{if(!errors.some(item=>Object.is(item,error)))errors.push(error);if(cleanup&&!cleanupErrors.some(item=>Object.is(item,error)))cleanupErrors.push(error);};
 const track=<T>(task:Promise<T>)=>{operations.add(task);void task.then(()=>operations.delete(task),()=>operations.delete(task));return task;};
 const valid=(index:number)=>{if(!Number.isInteger(index)||index<0||index>=count)throw new Error('Invalid queued actor input');};
 const finish=(input:number)=>{valid(input);queue.sendFinish(input);sendDone[input]=true;if(sendDone.every(Boolean))queue.sendFinish(count);};
 const context=(signal?:AbortSignal)=>{const combined=new AbortController(),internal=()=>{if(!combined.signal.aborted)combined.abort(controller.signal.reason);},external=()=>{if(!combined.signal.aborted)combined.abort(signal!.reason);};if(controller.signal.aborted)internal();else controller.signal.addEventListener('abort',internal,{once:true});if(signal?.aborted)external();else signal?.addEventListener('abort',external,{once:true});return {signal:combined.signal,close(){controller.signal.removeEventListener('abort',internal);signal?.removeEventListener('abort',external);}};};
 let scheduledSignal:AbortSignal|undefined,scheduledLease:LinkLease<Message>|undefined;
 const scheduler=createSchedulerReceiver<Message>({inputs:count,bestInput:0,
  update(input){return settings.scheduler?.update(input,scheduledSignal);},
  async receive(noBlock,signal){const next=noBlock?queue.tryReceive():await queue.receive(signal);scheduledLease=next.lease;return {code:next.code==='again'?-11:next.code,stream:next.stream,...(next.lease?{value:next.lease.value}:{})};},
  async wait(signal){return settings.scheduler?settings.scheduler.wait(signal):false;}
 });
 return {
  get desiredInput(){return scheduler.bestInput===count?null:scheduler.bestInput;},
  deliverScheduled(requested:number|null,signal?:AbortSignal){
   if(requested!==null)valid(requested);
   if(busy)throw new Error('Concurrent queued actor delivery');
   if(closing)return Promise.resolve({code:-541478725 as number|'again',stream:-1});
   busy=true;const ctx=context(signal);scheduledSignal=ctx.signal;
   return track((async()=>{try{
    const result=await scheduler.receive(requested??count,ctx.signal);
    if(result.code!==0)return {code:result.code,stream:-1};
    if(!scheduledLease)throw new Error('Scheduled actor event missing lease');
    const message=scheduledLease.value;
    if(result.requested===count){if(message.kind!=='control')throw new Error('Invalid control stream envelope');if(!settings.control)throw new Error('Filter control messages are not implemented');await settings.control(message.value,ctx.signal);ctx.signal.throwIfAborted();return {code:0 as number|'again',stream:count,control:true as const};}
    if(message.kind!=='input')throw new Error('Invalid input stream envelope');
    const accepted=await driver.admitInput(result.requested,message.value,settings.push??false);
    return {code:accepted?0:-541478725 as number|'again',stream:result.requested};
   }catch(error){if(closing&&Object.is(error,controller.signal.reason))return {code:-541478725 as number|'again',stream:-1};observe(error);throw error;
   }finally{
    try{scheduledLease?.release();}catch(error){observe(error,true);}
    scheduledLease=undefined;scheduledSignal=undefined;busy=false;ctx.close();
    if(cleanupErrors.length)throw errors[0];
   }})());
  },
  submitControl(lease:LinkLease<Control>,signal?:AbortSignal){if(closing)throw new Error('Queued actor delivery closed');const message:Message={kind:'control',value:lease.value},bytes=lease.bytes,release=lease.release.bind(lease),ctx=context(signal);return track((async()=>{try{return await queue.send(count,{value:message,bytes,release},ctx.signal);}catch(error){if(!(closing&&Object.is(error,controller.signal.reason))&&!(signal?.aborted&&Object.is(error,signal.reason)))observe(error);throw error;}finally{ctx.close();}})());},
  get failures(){return Object.freeze([...errors]);},get cleanupErrors(){return Object.freeze([...cleanupErrors]);},get state(){return queue.snapshot();},
  trySubmit(input:number,lease:LinkLease<ActorSourceEvent>){valid(input);if(closing)throw new Error('Queued actor delivery closed');const code=queue.trySend(input,{value:{kind:'input',value:lease.value},bytes:lease.bytes,release:lease.release.bind(lease)});if(code===-541478725)finish(input);return code;},
  submit(destinations:readonly number[],lease:LinkLease<ActorSourceEvent>,signal?:AbortSignal){const targets=[...destinations];if(!targets.length||new Set(targets).size!==targets.length)throw new Error('Invalid queued actor destinations');for(const input of targets)valid(input);if(!Number.isSafeInteger(lease.bytes)||lease.bytes<0||lease.bytes>settings.maxBytes||typeof lease.release!=='function')throw new Error('Invalid decoded event lease');if(closing)throw new Error('Queued actor delivery closed');const event=lease.value,size=lease.bytes,releaseOwner=lease.release.bind(lease),ctx=context(signal);let remaining=targets.length;const release=()=>{if(--remaining===0)try{releaseOwner();}catch(error){observe(error,true);if(!controller.signal.aborted)controller.abort(error);}};
   return track((async()=>{let next=0;try{for(;next<targets.length;next++){const code=await queue.send(targets[next]!,{value:{kind:'input',value:event},bytes:size,release},ctx.signal);if(code===-541478725){release();finish(targets[next]!);}else if(code!==0)throw new Error('Queued actor input send failed: '+code);}return true;}catch(error){for(;next<targets.length;next++)release();if(!(closing&&Object.is(error,controller.signal.reason)))observe(error);throw error;}finally{ctx.close();}})());
  },
  deliverNext(wait=false,signal?:AbortSignal){if(busy)throw new Error('Concurrent queued actor delivery');if(closing)return Promise.resolve({code:-541478725 as number|'again',stream:-1});busy=true;const ctx=context(signal);return track((async()=>{try{for(;;){ctx.signal.throwIfAborted();const result=wait?await queue.receive(ctx.signal):queue.tryReceive();if(result.code===-541478725&&result.stream>=0)continue;if(result.code!==0)return {code:result.code,stream:result.stream};if(!result.lease)throw new Error('Queued actor event missing lease');try{const message=result.lease.value;if(result.stream===count){if(message.kind!=='control')throw new Error('Invalid control stream envelope');if(!settings.control)throw new Error('Filter control messages are not implemented');await settings.control(message.value,ctx.signal);ctx.signal.throwIfAborted();return {code:0 as number|'again',stream:count,control:true as const};}if(message.kind!=='input')throw new Error('Invalid input stream envelope');const accepted=await driver.admitInput(result.stream,message.value);if(!accepted)return {code:-541478725 as number|'again',stream:result.stream};return {code:0 as number|'again',stream:result.stream};}catch(error){observe(error);throw error;}finally{result.lease.release();if(cleanupErrors.length)throw errors[0];}}}catch(error){if(closing&&Object.is(error,controller.signal.reason))return {code:-541478725 as number|'again',stream:-1};observe(error);throw error;}finally{busy=false;ctx.close();}})());},
  finishInput:finish,
  closeInput(input:number){valid(input);queue.receiveFinish(input);receiveDone[input]=true;if(receiveDone.every(Boolean))queue.receiveFinish(count);},
  close(reason:unknown=new Error('Queued actor delivery closed')){return disposal??=(async()=>{closing=true;if(!controller.signal.aborted)controller.abort(reason);await Promise.allSettled([...operations]);try{queue.dispose();}catch(error){observe(error,true);}for(const error of queue.cleanupErrors)observe(error,true);if(errors.length)throw errors[0];})();}
 };
}
