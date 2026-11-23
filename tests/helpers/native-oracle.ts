import {execFile} from 'node:child_process';
/** Host-only test oracle; settle after both callback completion and process close. */
export function createNativeOracle(){
 let calls=0,active=0,peak=0,failures=0;
 return {get metrics(){return {calls,active,peak,failures};},run(binary:string,args:readonly string[],signal:AbortSignal):Promise<Buffer>{
  signal.throwIfAborted();calls++;active++;peak=Math.max(peak,active);
  return new Promise((resolve,reject)=>{let closed=false,callback=false,settled=false,failure:Error|null=null,output:Buffer=Buffer.alloc(0);
   const finish=()=>{if(settled||!closed||!callback)return;settled=true;active--;if(failure){failures++;reject(failure);}else resolve(output);};
   try{const child=execFile(binary,[...args],{encoding:null,maxBuffer:1048576,signal},(error,stdout)=>{callback=true;failure=error;output=stdout;finish();});child.once('close',()=>{closed=true;finish();});}
   catch(error){active--;failures++;reject(error);}
  });
 }};
}
/** Lazily pull jobs, bounding live cases, temporary inputs and Native children. */
export async function runBoundedCases<T>(cases:Iterable<T>,concurrency:number,signal:AbortSignal,run:(value:T,signal:AbortSignal)=>Promise<void>):Promise<number>{
 signal.throwIfAborted();if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4)throw new RangeError('Invalid Native oracle concurrency');
 const controller=new AbortController(),forward=()=>controller.abort(signal.reason);signal.addEventListener('abort',forward,{once:true});
 const iterator=cases[Symbol.iterator]();let failed=false,failure:unknown,completed=0;
 async function worker(){while(!failed){try{controller.signal.throwIfAborted();const next=iterator.next();if(next.done)return;await run(next.value,controller.signal);completed++;}catch(error){if(!failed){failed=true;failure=error;controller.abort(error);}return;}}}
 try{await Promise.all(Array.from({length:concurrency},()=>worker()));if(signal.aborted)throw signal.reason;if(failed)throw failure;return completed;}
 finally{signal.removeEventListener('abort',forward);iterator.return?.();}
}
