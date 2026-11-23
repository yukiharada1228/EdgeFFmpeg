import type {R2Bucket} from '@cloudflare/workers-types';
import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
import type {MediaCheckpointStatus} from './types.js';
import type {MediaCheckpointJournal} from './runner.js';
import {mediaCheckpointCoordinatorName,snapshotMediaCheckpointDescriptor,snapshotMediaCheckpointIdentity} from './state.js';
export interface CollectMediaCheckpointOrphansOptions {
 readonly bucket:Pick<R2Bucket,'list'|'delete'>;readonly journal:Pick<MediaCheckpointJournal,'status'>;readonly identity:ExecutionCheckpointIdentity;
 readonly dryRun?:boolean;readonly maxObjects?:number;readonly maxDeletes?:number;readonly maxPages?:number;readonly pageSize?:number;
 /** Continue a pass after this key: a previous report's `next` (the report's `prefix` restarts the pass). */
 readonly startAfter?:string;readonly signal?:AbortSignal;
}
/** `failed` is only reported through `MediaCheckpointCollectionError.report`. */
export type MediaCheckpointCollectionOutcome='collected'|'live-lease'|'missing-journal'|'aborted'|'failed';
/** `terminal`: finished/cancelled journal; `fenced`: generation at or below the last committer of a lease-free journal. */
export type MediaCheckpointDeletedReason='terminal'|'fenced';
/** Retained by the safety rule. */
export type MediaCheckpointKeptReason='committed'|'live-lease'|'unfenced'|'unrecognized';
/** Not deleted by this run for a run-level reason; `aborted` keys may be unclassified; `failed` keys may have been deleted by the failed batch. */
export type MediaCheckpointSkippedReason='dry-run'|'max-deletes'|'aborted'|'failed';
export interface MediaCheckpointCollectionReport {
 readonly outcome:MediaCheckpointCollectionOutcome;readonly phase:MediaCheckpointStatus['phase']|null;readonly dryRun:boolean;readonly prefix:string;readonly pages:number;readonly listed:number;
 /** `startAfter` that resumes this pass: just before the first unsettled key (skipped `max-deletes`/`aborted`/`failed` or kept `live-lease`),
  * else the last listed key when a bound stopped listing; null only when the listing reached the end with every listed key settled. */
 readonly next:string|null;
 readonly deleted:readonly {readonly key:string;readonly reason:MediaCheckpointDeletedReason}[];
 readonly kept:readonly {readonly key:string;readonly reason:MediaCheckpointKeptReason}[];
 readonly skipped:readonly {readonly key:string;readonly reason:MediaCheckpointSkippedReason}[];
}
/** A failure once deletion began; `report` (outcome `failed`) records what this run deleted. */
export class MediaCheckpointCollectionError extends Error {
 constructor(readonly report:MediaCheckpointCollectionReport,cause:unknown){super('Checkpoint collection stopped after deleting '+report.deleted.length+' objects: '+(cause instanceof Error?cause.message:String(cause)),{cause});}
}
interface Journal {readonly phase:MediaCheckpointStatus['phase'];readonly live:boolean;readonly fenced:number;readonly referenced:ReadonlySet<string>;readonly commits:readonly string[]}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const integer=(value:number,min:number,max:number)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const marker=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const canonical=(value:unknown)=>typeof value==='string'&&value.length<=128&&/^(0|[1-9][0-9]*)$/.test(value);
/** Exact `mediaCheckpointObjectPrefix` attempt layout; any other key is never collectable. */
function attempt(root:string,key:string):{generation:number;revision:number;prefix:string;file:string}|null {
 const match=key.startsWith(root)?/^([1-9][0-9]{0,15})\/([-_A-Za-z0-9]{1,128})\/revision-([1-9][0-9]{0,2})\/(state|output)\.bin$/.exec(key.slice(root.length)):null;
 if(!match)return null;const generation=Number(match[1]),revision=Number(match[3]),file=match[4]!;
 return Number.isSafeInteger(generation)&&revision<=256?{generation,revision,prefix:key.slice(0,-(file.length+4)),file}:null;
}
function journalOf(value:MediaCheckpointStatus|null,identity:ExecutionCheckpointIdentity,root:string):Journal|null {
 if(value===null)return null;
 if(!value||!same(snapshotMediaCheckpointIdentity(value.identity),identity)||!['ready','running','finished','cancelled'].includes(value.phase)||!Number.isInteger(value.revision)||value.revision<0||value.revision>256||!Array.isArray(value.commits)||value.commits.length!==value.revision||!canonical(value.inputPosition)||!canonical(value.outputPosition))throw Error('Checkpoint journal status is inconsistent with this collection');
 const lease=value.lease;if((value.phase==='running')!==(lease!==null)||lease!==null&&(!lease||!Number.isSafeInteger(lease.generation)||lease.generation<1||typeof lease.token!=='string'||!/^[-_A-Za-z0-9]{1,128}$/.test(lease.token)))throw Error('Checkpoint journal lease is inconsistent with its phase');
 const referenced=new Set<string>(),commits:string[]=[];let fenced=0;
 for(const [index,entry]of value.commits.entries()){
  const commit=snapshotMediaCheckpointDescriptor(entry),owner=attempt(root,commit.state.key);
  // The coordinator only commits keys under the committing lease's prefix, so a commit key proves its generation once held the lease.
  if(commit.revision!==index+1||!same(commit.identity,identity)||!owner||owner.file!=='state'||owner.revision!==commit.revision||commit.output&&commit.output.key!==owner.prefix+'output.bin')throw Error('Checkpoint commit is not owned by this journal');
  referenced.add(commit.state.key);if(commit.output)referenced.add(commit.output.key);fenced=Math.max(fenced,owner.generation);commits.push(JSON.stringify(commit));
 }
 return {phase:value.phase,live:lease!==null,fenced:value.phase==='finished'||value.phase==='cancelled'?Infinity:fenced,referenced,commits};
}
// The safety proof needs a monotonic journal: commits only append and terminal phases never change.
function advance(previous:Journal,next:Journal|null):Journal {
 if(!next||next.commits.length<previous.commits.length||previous.commits.some((commit,index)=>next.commits[index]!==commit)||previous.fenced===Infinity&&(next.phase!==previous.phase||next.commits.length!==previous.commits.length))throw Error('Checkpoint journal regressed during collection');
 return next;
}
/** Delete provably unreferenced attempt objects of one job/WorkUnit journal.
 *
 * Lists one bounded window of `checkpoints/<namespace>/` and deletes only exact
 * attempt-layout keys listed with the `prepareMediaCheckpoint` digest marker
 * that no journal commit references, when no lease is live and the key's
 * attempt is fenced: every generation of a finished/cancelled journal, or
 * generations up to the last committer of a lease-free journal (later leases
 * always take a higher generation). The journal is re-read after listing and
 * before every delete batch; a live lease stops the run. R2 deletes are
 * unconditional, which is sound because eligibility is permanent per key.
 * Failures after deletion began throw `MediaCheckpointCollectionError`.
 */
export async function collectMediaCheckpointOrphans(options:CollectMediaCheckpointOrphansOptions):Promise<MediaCheckpointCollectionReport>{
 const {bucket,journal,signal,startAfter}=options,dryRun=options.dryRun??false,maxObjects=options.maxObjects??1024,maxDeletes=options.maxDeletes??maxObjects,maxPages=options.maxPages??16,pageSize=options.pageSize??1000;
 if(!integer(maxObjects,1,4096)||!integer(maxDeletes,1,4096)||!integer(maxPages,1,1024)||!integer(pageSize,1,1000))throw RangeError('Invalid checkpoint collection limits');
 if(!bucket||typeof bucket.list!=='function'||typeof bucket.delete!=='function'||!journal||typeof journal.status!=='function'||typeof dryRun!=='boolean')throw TypeError('Invalid checkpoint collection bucket, journal or mode');
 const identity=snapshotMediaCheckpointIdentity(options.identity),root='checkpoints/'+await mediaCheckpointCoordinatorName(identity)+'/';
 if(startAfter!==undefined&&(typeof startAfter!=='string'||startAfter.length>1024||!startAfter.startsWith(root)||/[\\\0]/.test(startAfter)||startAfter.slice(root.length).split('/').some(part=>part==='.'||part==='..')))throw TypeError('Checkpoint collection cursor escapes its prefix');
 const deleted:{key:string;reason:MediaCheckpointDeletedReason}[]=[],kept:{key:string;reason:MediaCheckpointKeptReason}[]=[],skipped:{key:string;reason:MediaCheckpointSkippedReason}[]=[],keys:string[]=[],seen=new Set<string>(),marked=new Set<string>();
 let pages=0,ended=false,phase:MediaCheckpointStatus['phase']|null=null;
 const report=(outcome:MediaCheckpointCollectionOutcome):MediaCheckpointCollectionReport=>{
  // Resume before the first unsettled key so that a continued pass revisits it.
  const held=new Set([...skipped.filter(entry=>entry.reason!=='dry-run'),...kept.filter(entry=>entry.reason==='live-lease')].map(entry=>entry.key)),index=keys.findIndex(key=>held.has(key));
  const next=index>0?keys[index-1]!:index===0||!ended&&!keys.length?startAfter??root:ended?null:keys.at(-1)!;
  return {outcome,phase,dryRun,prefix:root,pages,listed:keys.length,next,deleted,kept,skipped};
 };
 const abandon=(rest:readonly string[])=>{for(const key of rest)skipped.push({key,reason:'aborted'});return report('aborted');};
 const read=async(previous:Journal)=>{const value=advance(previous,journalOf(await journal.status(),identity,root));phase=value.phase;return value;};
 if(signal?.aborted)return report('aborted');
 let current=journalOf(await journal.status(),identity,root);if(!current)return report('missing-journal');phase=current.phase;if(current.live)return report('live-lease');
 // A partial window is safe: every decision is per listed key.
 for(let cursor:string|undefined;!ended;){
  if(signal?.aborted)return abandon(keys);
  if(pages>=maxPages||keys.length>=maxObjects)break;
  const limit=Math.min(pageSize,maxObjects-keys.length),page=await bucket.list({prefix:root,limit,include:['customMetadata'],...(cursor!==undefined?{cursor}:startAfter!==undefined?{startAfter}:{})});pages++;
  if(!page||!Array.isArray(page.objects)||page.objects.length>limit||typeof page.truncated!=='boolean'||page.truncated&&(typeof page.cursor!=='string'||!page.cursor||!page.objects.length))throw Error('Invalid checkpoint listing page');
  for(const object of page.objects){const key=object?.key;if(typeof key!=='string'||!key.startsWith(root))throw Error('Checkpoint listing escaped its prefix');if(seen.has(key))throw Error('Checkpoint listing repeated a key');seen.add(key);keys.push(key);if(marker(object.customMetadata?.edgeCheckpointSha256))marked.add(key);}
  ended=!page.truncated;if(page.truncated)cursor=page.cursor;
 }
 if(signal?.aborted)return abandon(keys);
 // Only listed versions written by prepareMediaCheckpoint (digest marker) are attempt objects; a VFS write at an attempt-shaped key is not.
 const verdict=(key:string,value:Journal):MediaCheckpointKeptReason|null=>{const owner=attempt(root,key);return !owner?'unrecognized':value.referenced.has(key)?'committed':!marked.has(key)?'unrecognized':value.live?'live-lease':owner.generation>value.fenced?'unfenced':null;};
 // Re-read after listing: a claim or commit that raced the listing is visible here.
 current=await read(current);const candidates:string[]=[];
 for(const key of keys){const reason=verdict(key,current);if(reason)kept.push({key,reason});else candidates.push(key);}
 if(current.live)return report('live-lease');
 // A dry run applies the same bound, so its plan is exactly what a real run with these options would attempt.
 for(const key of candidates.splice(maxDeletes))skipped.push({key,reason:'max-deletes'});
 if(dryRun){for(const key of candidates)skipped.push({key,reason:'dry-run'});return report('collected');}
 let offset=0;
 try{
  for(;offset<candidates.length;offset+=pageSize){
   if(signal?.aborted)return abandon(candidates.slice(offset));
   // Re-read immediately before deleting; a live lease stops the run without deleting.
   current=await read(current);
   if(current.live){for(const key of candidates.slice(offset))kept.push({key,reason:verdict(key,current)!});return report('live-lease');}
   const batch:string[]=[],reason=current.fenced===Infinity?'terminal':'fenced';
   for(const key of candidates.slice(offset,offset+pageSize)){const retained=verdict(key,current);if(retained)kept.push({key,reason:retained});else batch.push(key);}
   // A batch already sent is not abandoned on abort.
   if(batch.length){await bucket.delete(batch);for(const key of batch)deleted.push({key,reason});}
  }
 }catch(error){
  // A failed batch may be partly applied; deleting a missing key is a no-op, so its keys and the rest are reported `failed` for a rerun.
  const settled=new Set(kept.map(entry=>entry.key));for(const key of candidates.slice(offset))if(!settled.has(key))skipped.push({key,reason:'failed'});
  throw new MediaCheckpointCollectionError(report('failed'),error);
 }
 return report('collected');
}
