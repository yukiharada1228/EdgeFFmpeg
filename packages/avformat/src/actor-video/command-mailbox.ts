/** Bounded host reply ownership around the graph's typed control FIFO. */
export interface ExpressionCommand {readonly target:string;readonly expression:string;readonly flags:number;readonly time?:number;readonly responseCapacity?:number;readonly expressionKind?:'expr'|'enable';readonly commandName?:string}
/** accepted waits only for FIFO admission; reply needs the execution loop to run.
 * For timed commands reply reports registration, not later expression validity.
 * A sink callback must return without awaiting accepted or reply: admission
 * can also block on a full FIFO owned by that same graph thread.
 * Cancellation before handling skips execution; an already executing command
 * cannot roll back mutations when its caller cancels. */
export interface CommandReply {readonly code:number;readonly response?:Uint8Array}
export interface CommandTicket {readonly accepted:Promise<number|'again'>;readonly reply:Promise<CommandReply>}
export function createCommandMailbox(options:{maxPending:number;submit(lease:{value:ExpressionCommand;bytes:number;release():void},signal?:AbortSignal):Promise<number|'again'>;execute(command:ExpressionCommand):Promise<CommandReply>}){
 const settings={...options};if(!Number.isSafeInteger(settings.maxPending)||settings.maxPending<1)throw new Error('Invalid command reply budget');
 interface Pending {command:ExpressionCommand;settled:boolean;released:boolean;resolve(value:CommandReply):void;reject(reason:unknown):void;detach():void}
 const pending=new Map<ExpressionCommand,Pending>();let closed=false;
 const settle=(item:Pending,result:CommandReply|undefined,error?:unknown)=>{if(item.settled)return;item.settled=true;item.detach();if(result)item.resolve(item.command.responseCapacity===undefined?result:{...result,response:result.response??new Uint8Array(0)});else item.reject(error);};
 return {
  get pending(){return pending.size;},
  submit(target:string,expression:string,flags=0,signal?:AbortSignal,time?:number,responseCapacity?:number,expressionKind:'expr'|'enable'='expr',commandName?:string):CommandTicket{
   if(closed)throw new Error('Command mailbox closed');
   if(typeof target!=='string'||target.length>256||target.includes('\0')||typeof expression!=='string'||expression.length>4096||expression.includes('\0')||!Number.isInteger(flags)||flags< -2147483648||flags>2147483647||time!==undefined&&typeof time!=='number'||responseCapacity!==undefined&&(!Number.isSafeInteger(responseCapacity)||responseCapacity<0||responseCapacity>65536||time!==undefined))throw new Error('Invalid expression command');
   if(!['expr','enable'].includes(expressionKind)||expressionKind==='enable'&&responseCapacity!==undefined)throw new Error('Invalid expression command kind');
   if(commandName!==undefined&&(typeof commandName!=='string'||commandName.length>4096||commandName.includes('\0')||expressionKind!=='expr'))throw new Error('Invalid generic filter command');
   signal?.throwIfAborted();if(pending.size>=settings.maxPending)throw new Error('Pending command reply budget exceeded');
   const command=Object.freeze({target,expression,flags,...(time===undefined?{}:{time}),...(responseCapacity===undefined?{}:{responseCapacity}),...(expressionKind==='enable'?{expressionKind}:{}),...(commandName===undefined?{}:{commandName})});let resolve!:(value:CommandReply)=>void,reject!:(reason:unknown)=>void;
   const reply=new Promise<CommandReply>((yes,no)=>{resolve=yes;reject=no;});void reply.catch(()=>{});
   const abort=()=>settle(item,undefined,signal!.reason);
   const item:Pending={command,settled:false,released:false,resolve,reject,detach(){signal?.removeEventListener('abort',abort);}};
   pending.set(command,item);signal?.addEventListener('abort',abort,{once:true});
   const release=()=>{if(item.released)return;item.released=true;pending.delete(command);settle(item,{code:-541478725});};
   let sending:Promise<number|'again'>;
   try{sending=settings.submit({value:command,bytes:(target.length+expression.length+(commandName?.length??0))*2+(time===undefined?8:16),release},signal);}catch(error){settle(item,undefined,error);release();throw error;}
   const accepted=sending.then(code=>{if(code!==0)release();return code;},error=>{settle(item,undefined,error);release();throw error;});void accepted.catch(()=>{});
   return Object.freeze({accepted,reply});
  },
  async handle(command:ExpressionCommand){const item=pending.get(command);if(!item||item.settled)return;try{settle(item,await settings.execute(command));}catch(error){settle(item,undefined,error);throw error;}},
  close(reason?:unknown){if(closed)return;closed=true;for(const item of pending.values())if(reason===undefined)settle(item,{code:-541478725});else settle(item,undefined,reason);}
 };
}
