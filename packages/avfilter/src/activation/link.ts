// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapts pinned avfilter.c status, request and video frame queue transitions.
// Copyright (c) 2007 Bobby Bingham. See NOTICE.activation and root LGPL license.
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
export interface LinkLease<T>{value:T;bytes:number;release():void}
export function createActivationLink<T>(options:{source:number;destination:number;maxFrames:number;maxBytes:number;mark(node:number,priority:number):void;unblockDestination?():void;onPts?(pts:bigint):void}){
 const settings={...options};if(![settings.source,settings.destination].every(index=>Number.isSafeInteger(index)&&index>=0)||typeof settings.mark!=='function'||settings.unblockDestination!==undefined&&typeof settings.unblockDestination!=='function'||settings.onPts!==undefined&&typeof settings.onPts!=='function')throw new Error('Invalid activation link endpoints or callbacks');for(const n of [settings.maxFrames,settings.maxBytes])if(!Number.isSafeInteger(n)||n<1)throw new Error('Invalid activation link budget');
 const queue:{lease:LinkLease<T>;pts:bigint|null}[]=[];let bytes=0,statusIn=0,statusOut=0,statusPts:bigint|null=0n,currentPts:bigint|null=null,wanted=false,blocked=false,frameIn=0n,frameOut=0n,disposed=false;
 const active=()=>{if(disposed)throw new Error('Activation link disposed');},known=(pts:bigint|null)=>{if(pts===null||pts===MIN)return null;if(typeof pts!=='bigint'||pts<MIN||pts>MAX)throw new Error('Activation link PTS exceeds signed64');return pts;},status=(code:number)=>{if(!Number.isInteger(code)||code>=0||code< -2147483648)throw new Error('Invalid activation link status');};
 const unblock=()=>settings.unblockDestination?.();
 const clear=()=>{const errors:unknown[]=[];for(const item of queue.splice(0))try{item.lease.release();}catch(error){errors.push(error);}bytes=0;if(errors.length)throw new AggregateError(errors,'Activation link release failed');};
 return {
  snapshot(){return Object.freeze({queued:queue.length,bytes,currentPts,statusIn,statusOut,statusPts,wanted,blocked,frameIn,frameOut});},
  enqueue(lease:LinkLease<T>,pts:bigint|null){active();pts=known(pts);if(statusIn||statusOut)throw new Error('Frame after activation link status');if(queue.length>=settings.maxFrames||!Number.isSafeInteger(lease.bytes)||lease.bytes<0||lease.bytes>settings.maxBytes-bytes)throw new Error('Activation link queue budget exceeded');if(queue.some(item=>item.lease===lease))throw new Error('Activation link lease already queued');queue.push({lease,pts});bytes+=lease.bytes;wanted=blocked=false;frameIn++;unblock();settings.mark(settings.destination,300);},
  consume(){active();const item=queue.shift();if(!item)return null;bytes-=item.lease.bytes;if(item.pts!==null){currentPts=item.pts;settings.onPts?.(item.pts);}frameOut++;return item.lease;},
  request(){active();if(statusIn||statusOut)throw new Error('Request after activation link status');wanted=true;settings.mark(settings.source,100);},
  setSourceStatus(code:number,pts:bigint|null){active();status(code);pts=known(pts);if(statusIn===code)return;if(statusIn)throw new Error('Activation link source status already set');statusIn=code;statusPts=pts;wanted=blocked=false;unblock();settings.mark(settings.destination,200);},
  acknowledge(){active();if(queue.length)return {result:0,status:0,pts:currentPts};if(statusOut)return {result:statusOut,status:statusOut,pts:currentPts};if(!statusIn)return {result:0,status:0,pts:currentPts};statusOut=statusIn;if(statusPts!==null){currentPts=statusPts;settings.onPts?.(statusPts);}return {result:1,status:statusOut,pts:currentPts};},
  closeDestination(code:number){active();status(code);if(statusOut)return;wanted=blocked=false;statusOut=code;unblock();settings.mark(settings.source,200);if(!statusIn)statusIn=code;clear();},
  dispose(){if(disposed)return;disposed=true;clear();}
 };
}
