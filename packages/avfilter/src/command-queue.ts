// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned avfiltergraph.c/avfilter.c; see ../NOTICE.
export interface QueuedFilterCommand {readonly name:string;readonly argument:string;readonly time:number;readonly flags:number}
export interface FilterCommandQueueOptions {readonly maxCommands:number;readonly maxBytes:number}
export type FilterCommandInput=Omit<QueuedFilterCommand,'flags'>&{readonly flags?:number};
/** Resolved destination indices in Native graph registration order. */
export function createFilterCommandQueue(nodes:number,options:FilterCommandQueueOptions){
 const {maxCommands,maxBytes}=options;
 if(!Number.isSafeInteger(nodes)||nodes<1||nodes>128||![maxCommands,maxBytes].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid filter command queue limits');
 const queues=Array.from({length:nodes},()=>[] as {command:QueuedFilterCommand;bytes:number}[]);let commands=0,bytes=0,disposed=false,busy=false;
 const active=()=>{if(disposed)throw new Error('Filter command queue disposed');if(busy)throw new Error('Reentrant filter command queue mutation');};
 const validNode=(node:number)=>{if(!Number.isSafeInteger(node)||node<0||node>=nodes)throw new Error('Invalid filter command destination');};
 return {
  get usage(){return Object.freeze({commands,bytes});},
  get snapshot(){return Object.freeze({commands,bytes,queues:Object.freeze(queues.map(queue=>Object.freeze(queue.map(item=>item.command))))});},
  enqueue(destinations:readonly number[],input:FilterCommandInput){
   active();busy=true;try{if(!Array.isArray(destinations))throw new Error('Invalid filter command destinations');const length=destinations.length;if(!Number.isSafeInteger(length)||length<0||length>nodes)throw new Error('Invalid filter command destinations');const targets:number[]=[];for(let index=0;index<length;index++)targets.push(destinations[index]!);for(const node of targets)validNode(node);if(new Set(targets).size!==targets.length)throw new Error('Duplicate filter command destination');
   const {name,argument,time,flags=0}=input;
   if(typeof name!=='string'||name.length>4096||name.includes('\0')||typeof argument!=='string'||argument.length>4096||argument.includes('\0')||typeof time!=='number'||!Number.isInteger(flags)||flags< -2147483648||flags>2147483647)throw new Error('Invalid queued filter command');
   const selected=flags&1?targets.slice(0,1):targets,size=32+2*(name.length+argument.length);
   if(selected.length>maxCommands-commands||selected.length*size>maxBytes-bytes)throw new Error('Filter command queue budget exceeded');
   const command=Object.freeze({name,argument,time,flags});for(const node of selected){const queue=queues[node]!;let position=0;while(position<queue.length&&queue[position]!.command.time<=time)position++;queue.splice(position,0,{command,bytes:size});commands++;bytes+=size;}
   return {code:0};}finally{busy=false;}
  },
  process(node:number,seconds:number,execute:(command:QueuedFilterCommand)=>number|void){
   active();validNode(node);if(typeof seconds!=='number'||typeof execute!=='function')throw new Error('Invalid filter command processing context');const queue=queues[node]!;busy=true;
   try{while(queue.length&&queue[0]!.command.time<=seconds){const item=queue[0]!;try{const code=execute(item.command);if(code!==undefined&&!Number.isInteger(code))throw new Error('Filter command callback must be synchronous');}finally{queue.shift();commands--;bytes-=item.bytes;}}}finally{busy=false;}
  },
  dispose(){if(disposed)return;active();disposed=true;for(const queue of queues)queue.length=0;commands=0;bytes=0;}
 };
}
