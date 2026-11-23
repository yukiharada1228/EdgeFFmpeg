import {ExecutionError} from '@edge-ffmpeg/core';
import type {VirtualFileSystem,WriteHandle} from '@edge-ffmpeg/core';
export type OutputStatus='writing'|'prepared'|'committing'|'published'|'uncertain'|'aborted'|'cleanup-failed';
export interface OutputEffect{readonly path:string;readonly status:OutputStatus}
export class OutputGroupError extends ExecutionError{
 readonly publishedOutputs:readonly string[];
 constructor(message:string,readonly effects:readonly OutputEffect[],cause:unknown,readonly cleanupErrors:readonly unknown[]=[]){super('output-publication-failed',message,{exitCode:cause instanceof ExecutionError&&cleanupErrors.length===0&&effects.every(effect=>effect.status==='aborted')?cause.exitCode:1});this.cause=cause;this.effects=Object.freeze(effects.map(effect=>Object.freeze({...effect})));this.cleanupErrors=Object.freeze([...cleanupErrors]);this.publishedOutputs=Object.freeze(this.effects.filter(effect=>effect.status==='published').map(effect=>effect.path));}
}
interface Entry{path:string;handle:WriteHandle;status:OutputStatus;busy:boolean;pending:Promise<void>|null;abortPending:Promise<void>|null}
const published=(error:unknown)=>typeof error==='object'&&error!==null&&'published' in error&&error.published===true;
/** Defers publication until every muxer is prepared. Publication across files is ordered. */
export async function openOutputGroup(filesystem:VirtualFileSystem,paths:readonly string[],overwrite:boolean,signal:AbortSignal){
 if(!paths.length||new Set(paths).size!==paths.length)throw new ExecutionError('invalid-arguments','Output paths must be nonempty and unique');
 const entries:Entry[]=[],effects=()=>Object.freeze(entries.map(entry=>Object.freeze({path:entry.path,status:entry.status})));let terminal=false,aborting=false,abortReason:unknown,cleanupFlight:Promise<readonly unknown[]>|null=null;
 const abortEntry=(entry:Entry,reason:unknown):Promise<void>=>{
  if(entry.abortPending)return entry.abortPending;
  const task=(async()=>{if(entry.pending)try{await entry.pending;}catch{}if(entry.status==='published'||entry.status==='aborted')return;const uncertain=entry.status==='uncertain'||entry.status==='committing';try{await entry.handle.abort(reason);if(!uncertain)entry.status='aborted';}catch(error){if(!uncertain)entry.status='cleanup-failed';throw error;}})();entry.abortPending=task;void task.then(()=>{if(entry.abortPending===task)entry.abortPending=null;},()=>{if(entry.abortPending===task)entry.abortPending=null;});return task;
 };
 const cleanup=(reason:unknown):Promise<readonly unknown[]>=>{
  if(cleanupFlight)return cleanupFlight;
  cleanupFlight=(async()=>{const errors:unknown[]=[];for(const entry of entries)try{await abortEntry(entry,reason);}catch(error){errors.push(error);}return Object.freeze(errors);})();
  const current=cleanupFlight;void current.finally(()=>{if(cleanupFlight===current)cleanupFlight=null;});return current;
 };
 try{for(const path of paths){signal.throwIfAborted();entries.push({path,handle:await filesystem.openWrite(path,{overwrite}),status:'writing',busy:false,pending:null,abortPending:null});}signal.throwIfAborted();}catch(error){const errors=await cleanup(error);if(error instanceof ExecutionError&&error.code==='runtime-blocked'&&errors.length===0&&entries.every(entry=>entry.status==='aborted'))throw error;throw new OutputGroupError('Opening outputs failed',effects(),error,errors);}
 const writers=Object.freeze(entries.map(entry=>Object.freeze({
  async write(chunk:Uint8Array){signal.throwIfAborted();if(terminal||entry.status!=='writing'||entry.busy)throw new Error('Output is not writable');entry.busy=true;entry.pending=Promise.resolve().then(()=>entry.handle.write(chunk));try{await entry.pending;}finally{entry.pending=null;entry.busy=false;}signal.throwIfAborted();if(aborting)throw abortReason??new Error('Output cancelled');},
  async commit(){signal.throwIfAborted();if(terminal||entry.status!=='writing'||entry.busy)throw new Error('Output cannot prepare');entry.status='prepared';},
  async abort(reason?:unknown){await abortEntry(entry,reason);}

 })));
 return Object.freeze({writers,effects,
  async abort(reason?:unknown){terminal=true;aborting=true;abortReason=reason;const errors=await cleanup(reason);if(errors.length||entries.some(entry=>entry.status==='uncertain'))throw new OutputGroupError('Output cleanup incomplete',effects(),reason,errors);},
  async commit(){
   if(terminal){if(entries.every(entry=>entry.status==='published'))return;throw new OutputGroupError('Output group already failed',effects(),undefined);}
   if(entries.some(entry=>entry.status!=='prepared'||entry.busy))throw new Error('Every output must finish preparation before publication');
   try{if(!overwrite&&filesystem.outputExists)for(const entry of entries){signal.throwIfAborted();if(await filesystem.outputExists(entry.path,signal))throw new ExecutionError('output-exists','Output appeared before publication: '+entry.path);}for(const entry of entries){signal.throwIfAborted();if(aborting)throw abortReason??new Error('Output publication cancelled');entry.status='committing';entry.pending=Promise.resolve().then(()=>entry.handle.commit());try{await entry.pending;entry.status='published';}catch(error){entry.status=published(error)?'published':'uncertain';throw error;}finally{entry.pending=null;}signal.throwIfAborted();if(aborting)throw abortReason??new Error('Output publication cancelled');}terminal=true;}
   catch(error){terminal=true;const errors=await cleanup(error);throw new OutputGroupError('Output publication failed',effects(),error,errors);}
  }
 });
}
