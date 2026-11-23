// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned fftools/ffmpeg_sched.c sch_filter_receive; see NOTICE.activation.
const EOF=-541478725;
export interface ScheduledReceiveResult<T> {code:number;stream:number;value?:T|undefined}
/** Receive policy only. Queue ownership and producer scheduling remain with the caller. */
export function createSchedulerReceiver<T>(options:{inputs:number;bestInput:number;update(input:number):void|Promise<void>;receive(noBlock:boolean,signal?:AbortSignal):Promise<ScheduledReceiveResult<T>>;wait(signal?:AbortSignal):Promise<boolean>}){
 const settings={...options};
 if(!Number.isInteger(settings.inputs)||settings.inputs<1||settings.inputs>32||!Number.isInteger(settings.bestInput)||settings.bestInput<0||settings.bestInput>settings.inputs)throw new Error('Invalid scheduler input configuration');
 let best=settings.bestInput,busy=false;
 return {
  get bestInput(){return best;},
  async receive(requested:number,signal?:AbortSignal):Promise<{code:number|'again';requested:number;value?:T|undefined}>{
   if(!Number.isInteger(requested)||requested<0||requested>settings.inputs)throw new Error('Invalid desired scheduler input');
   if(busy)throw new Error('Concurrent scheduler receive');
   busy=true;
   try{
    signal?.throwIfAborted();
    if(requested!==best){best=requested;await settings.update(best);signal?.throwIfAborted();}
    if(requested===settings.inputs){
     const result=await settings.receive(true,signal);signal?.throwIfAborted();
     if(result.code>=0){if(result.stream<0||result.stream>settings.inputs)throw new Error('Invalid arrived scheduler input');return {code:0,requested:result.stream,value:result.value};}
     const terminate=await settings.wait(signal);signal?.throwIfAborted();
     return {code:terminate?EOF:'again',requested};
    }
    for(;;){
     const result=await settings.receive(false,signal);signal?.throwIfAborted();
     if(result.stream<0)return {code:EOF,requested};
     if(result.code>=0&&result.stream>settings.inputs)throw new Error('Invalid arrived scheduler input');
     if(result.code>=0)return {code:0,requested:result.stream,value:result.value};
     // Ignore per-stream finish markers, including the graph control stream.
     // The producer sent explicit media EOF frames before these markers.
    }
   }finally{busy=false;}
  }
 };
}
