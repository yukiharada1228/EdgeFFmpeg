import type {R2Bucket} from '@cloudflare/workers-types';
import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
import type {MediaCheckpointClaim,MediaCheckpointDescriptor,MediaCheckpointLease,MediaCheckpointStatus} from './types.js';
import {prepareMediaCheckpoint,loadMediaCheckpoint} from './artifacts.js';
import {finalizeMediaCheckpointOutput,MediaCheckpointOutputConflictError} from './output.js';
import type {FinalizeMediaCheckpointOutputOptions,FinalizedMediaCheckpointOutput} from './output.js';
import {snapshotMediaCheckpointDescriptor,snapshotMediaCheckpointIdentity} from './state.js';
/** Structural view of a `MediaCheckpointCoordinator` stub (or an equivalent
 * fake). The runner never calls `cancel()`; cancellation is observed. */
export interface MediaCheckpointJournal {
 initialize(identity:ExecutionCheckpointIdentity):Promise<MediaCheckpointStatus>;claim(leaseMs:number):Promise<MediaCheckpointClaim|null>;
 heartbeat(lease:MediaCheckpointLease):Promise<MediaCheckpointLease|null>;status():Promise<MediaCheckpointStatus|null>;
 commit(lease:MediaCheckpointLease,descriptor:MediaCheckpointDescriptor):Promise<MediaCheckpointStatus>;
}
/** Committed journal head (or the head a unit is about to commit). Output position is bytes. */
export interface MediaCheckpointPosition {readonly revision:number;readonly inputPosition:string;readonly outputPosition:string}
export interface MediaCheckpointUnit {readonly output:Uint8Array|null;readonly inputPosition:string;readonly finished:boolean}
/** Component adapter. `process` advances exactly one bounded input unit from
 * `position` and must not retain `output` views into future mutable storage
 * beyond the call (bytes are copied during preparation). `verify` compares the
 * component's own counters with a journal position and returns false on any
 * disagreement; it is called after create/restore and before every prepare. */
export interface MediaCheckpointComponent<S> {
 create():S|Promise<S>;restore(state:Uint8Array,position:MediaCheckpointPosition):S|Promise<S>;
 process(state:S,position:MediaCheckpointPosition,signal:AbortSignal|undefined):MediaCheckpointUnit|Promise<MediaCheckpointUnit>;
 serialize(state:S):Uint8Array;verify(state:S,position:MediaCheckpointPosition):boolean|Promise<boolean>;dispose?(state:S):void;
}
export interface RunCheckpointedMediaUnitOptions<S> {
 readonly bucket:R2Bucket;readonly journal:MediaCheckpointJournal;readonly identity:ExecutionCheckpointIdentity;readonly component:MediaCheckpointComponent<S>;
 readonly leaseMs:number;readonly maxUnits:number;readonly maxObjectBytes?:number;readonly maxCommitAttempts?:number;readonly signal?:AbortSignal;
 /** Lease this owner held when an earlier invocation yielded (`result.status.lease`). It is renewed
  * and reused only while the journal still names it; otherwise the runner claims as usual. Pass it
  * only once every invocation that used it has settled (returned or thrown): heartbeat and commit
  * compare generation and token only, so two live holders of one lease are indistinguishable. A
  * resumed lease reuses that owner's object prefix, so a revision it prepared but never committed
  * is prepared again and must serialize byte-identically (otherwise an immutable object conflict). */
 readonly resumeLease?:MediaCheckpointLease;
 readonly finalize?:Omit<FinalizeMediaCheckpointOutputOptions,'bucket'|'status'|'signal'|'maxObjectBytes'>;
}
export type MediaCheckpointRunOutcome='finished'|'yielded'|'busy'|'cancelled'|'lease-lost'|'aborted'|'output-conflict';
export interface MediaCheckpointRunResult {
 readonly outcome:MediaCheckpointRunOutcome;readonly status:MediaCheckpointStatus|null;readonly units:number;readonly commitRetries:number;
 /** Set only for `finished` with `finalize`: published now, or an existing no-clobber destination verified by size and SHA-256 (`existing: true`). */
 readonly finalized:FinalizedMediaCheckpointOutput|null;
 /** Set only for `output-conflict`: the existing destination differs from the finished journal's output. */
 readonly conflict:MediaCheckpointOutputConflictError|null;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const canonical=(value:unknown):value is string=>typeof value==='string'&&value.length<=128&&/^(0|[1-9][0-9]*)$/.test(value);
const head=(status:MediaCheckpointStatus):MediaCheckpointPosition=>({revision:status.revision,inputPosition:status.inputPosition,outputPosition:status.outputPosition});
function journalOf(status:MediaCheckpointStatus|null,identity:ExecutionCheckpointIdentity):MediaCheckpointStatus|null {
 if(status===null)return null;
 if(!status||!same(snapshotMediaCheckpointIdentity(status.identity),identity)||!['ready','running','finished','cancelled'].includes(status.phase)||!Number.isInteger(status.revision)||status.revision<0||status.revision>256||!Array.isArray(status.commits)||status.commits.length!==status.revision||!canonical(status.inputPosition)||!canonical(status.outputPosition))throw Error('Checkpoint journal status is inconsistent with this run');
 const last=status.commits.at(-1);if(last?snapshotMediaCheckpointDescriptor(last).revision!==status.revision||last.inputPosition!==status.inputPosition||last.outputPosition!==status.outputPosition:status.inputPosition!=='0'||status.outputPosition!=='0')throw Error('Checkpoint journal head disagrees with its latest commit');
 return status;
}
const holds=(status:MediaCheckpointStatus,lease:MediaCheckpointLease)=>status.phase==='running'&&status.lease!==null&&status.lease.generation===lease.generation&&status.lease.token===lease.token;
const contains=(status:MediaCheckpointStatus,descriptor:MediaCheckpointDescriptor)=>{const existing=status.commits[descriptor.revision-1];return existing!==undefined&&same(snapshotMediaCheckpointDescriptor(existing),descriptor);};
const bounded=(value:unknown,min:number,max:number)=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
// The same destination syntax finalizeMediaCheckpointOutput enforces.
const destination=(path:unknown)=>typeof path==='string'&&path.startsWith('/')&&!/[\\\0]/.test(path)&&path.slice(1).split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
type Finalize=NonNullable<RunCheckpointedMediaUnitOptions<unknown>['finalize']>;
interface Preflighted {readonly leaseMs:number;readonly maxUnits:number;readonly maxObjectBytes:number;readonly maxCommitAttempts:number;readonly resumeLease:MediaCheckpointLease|null;readonly finalize:Finalize|null}
function preflight<S>(options:RunCheckpointedMediaUnitOptions<S>):Preflighted {
 const {journal,component}=options,leaseMs=options.leaseMs,maxUnits=options.maxUnits,maxObjectBytes=options.maxObjectBytes??8388608,maxCommitAttempts=options.maxCommitAttempts??3;
 if(!bounded(leaseMs,10,300000)||!bounded(maxUnits,1,256)||!bounded(maxCommitAttempts,1,8)||!bounded(maxObjectBytes,1,67108864))throw RangeError('Invalid checkpoint runner limits');
 if(!journal||(['initialize','claim','heartbeat','status','commit'] as const).some(name=>typeof journal[name]!=='function')||!component||(['create','restore','process','serialize','verify'] as const).some(name=>typeof component[name]!=='function')||component.dispose!==undefined&&typeof component.dispose!=='function')throw TypeError('Invalid checkpoint runner journal or component');
 const resume=options.resumeLease;if(resume!==undefined&&(!resume||!bounded(resume.generation,1,Number.MAX_SAFE_INTEGER)||typeof resume.token!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(resume.token)||!bounded(resume.expiresAt,1,Number.MAX_SAFE_INTEGER)))throw TypeError('Invalid checkpoint runner resume lease');
 const resumeLease=resume?{generation:resume.generation,token:resume.token,expiresAt:resume.expiresAt}:null;
 if(options.finalize===undefined)return {leaseMs,maxUnits,maxObjectBytes,maxCommitAttempts,resumeLease,finalize:null};
 // Finalization is configured once and must not fail only after the last unit committed.
 const finalize={...options.finalize},files=finalize.filesystem;
 if(!files||typeof files.openWrite!=='function'||typeof files.openRead!=='function'||files.outputExists!==undefined&&typeof files.outputExists!=='function'||!destination(finalize.path)||finalize.overwrite!==undefined&&typeof finalize.overwrite!=='boolean'||finalize.patches!==undefined&&typeof finalize.patches!=='function')throw TypeError('Invalid checkpoint runner finalize options');
 const maxWriteBytes=finalize.maxWriteBytes??65536;
 if(!bounded(maxWriteBytes,1,maxObjectBytes)||!bounded(finalize.maxReadBytes??maxWriteBytes,1,maxObjectBytes)||!bounded(finalize.maxPatches??16,1,256)||!bounded(finalize.maxPatchBytes??4096,1,65536))throw RangeError('Invalid checkpoint runner finalize limits');
 return {leaseMs,maxUnits,maxObjectBytes,maxCommitAttempts,resumeLease,finalize};
}
/** Every limit, adapter and finalize check `runCheckpointedMediaUnit` performs before its first journal call, without I/O. */
export function preflightCheckpointedMediaUnit<S>(options:RunCheckpointedMediaUnitOptions<S>):void{preflight(options);snapshotMediaCheckpointIdentity(options.identity);}
/** Drive claim -> restore -> bounded units -> prepare -> commit -> finalize.
 *
 * Each invocation processes at most `maxUnits` committed transitions and then
 * yields; a later invocation with the same identity continues from the latest
 * committed revision. Component state is restored only from journal-committed
 * descriptors whose R2 pins and digests verify. An uncertain commit is retried
 * with the identical descriptor and original lease, and the journal is read
 * between attempts; nothing is rolled back. The lease is renewed before every
 * unit, so one unit (including its R2 reads/writes) must fit within `leaseMs`.
 * Signal abort is observed at unit boundaries, before finalization and inside
 * `process`; a commit already in flight is never abandoned midway. Every limit,
 * adapter and finalize option is validated before the first journal call.
 * A finished journal is always finalized: `finished` means published or
 * verified identical, and a differing no-clobber destination is `output-conflict`.
 * Component contract violations (counter disagreement, a unit that does not
 * advance, a malformed unit) throw `TypeError`.
 */
export async function runCheckpointedMediaUnit<S>(options:RunCheckpointedMediaUnitOptions<S>):Promise<MediaCheckpointRunResult>{
 const {bucket,journal,component,signal}=options,{leaseMs,maxUnits,maxObjectBytes,maxCommitAttempts,resumeLease,finalize}=preflight(options);
 const identity=snapshotMediaCheckpointIdentity(options.identity);let units=0,commitRetries=0;
 const result=(outcome:MediaCheckpointRunOutcome,status:MediaCheckpointStatus|null,finalized:FinalizedMediaCheckpointOutput|null=null,conflict:MediaCheckpointOutputConflictError|null=null):MediaCheckpointRunResult=>({outcome,status,units,commitRetries,finalized,conflict});
 const complete=async(status:MediaCheckpointStatus):Promise<MediaCheckpointRunResult>=>{
  if(!finalize)return result('finished',status);if(signal?.aborted)return result('aborted',status);
  // Replay after publication reaches finalize too: it verifies, never trusts, an existing destination.
  try{return result('finished',status,await finalizeMediaCheckpointOutput({...finalize,bucket,status,maxObjectBytes,...(signal?{signal}:{})}));}
  catch(error){if(error instanceof MediaCheckpointOutputConflictError)return result('output-conflict',status,null,error);if(signal?.aborted&&error===signal.reason)return result('aborted',status);throw error;}
 };
 const settle=(status:MediaCheckpointStatus|null):Promise<MediaCheckpointRunResult>|MediaCheckpointRunResult=>status?.phase==='finished'?complete(status):result(status?.phase==='cancelled'?'cancelled':'lease-lost',status);
 if(signal?.aborted)return result('aborted',null);
 const initial=journalOf(await journal.initialize(identity),identity)!;if(initial.phase==='finished'||initial.phase==='cancelled')return settle(initial);
 let claim:MediaCheckpointClaim|null=null;
 if(resumeLease){
  // Continue a lease this owner kept across a yield; an expired, stolen or fenced lease falls back to claim.
  const renewed=await journal.heartbeat(resumeLease);
  if(renewed){
   if(renewed.generation!==resumeLease.generation||renewed.token!==resumeLease.token)throw Error('Checkpoint heartbeat returned another lease');
   const current=journalOf(await journal.status(),identity);if(current?.phase==='finished'||current?.phase==='cancelled')return settle(current);
   if(current&&holds(current,renewed))claim={lease:current.lease!,status:current};
  }
 }
 claim??=await journal.claim(leaseMs);
 if(!claim){const status=journalOf(await journal.status(),identity);return status?.phase==='finished'||status?.phase==='cancelled'?settle(status):result('busy',status);}
 let lease=claim.lease,status=journalOf(claim.status,identity)!;if(!holds(status,lease)||!same(status.lease,lease))throw Error('Checkpoint claim does not hold its own lease');
 let state:S|undefined,live=false;
 try{
  const latest=status.commits.at(-1);
  // Restore only from the committed head; pins/digests are verified before decoding.
  if(latest){const loaded=await loadMediaCheckpoint(bucket,latest,maxObjectBytes);state=await component.restore(loaded.state,head(status));}else state=await component.create();live=true;
  if(await component.verify(state,head(status))!==true)throw TypeError('Component counters disagree with journal positions');
  for(;;){
   if(signal?.aborted)return result('aborted',status);if(units>=maxUnits)return result('yielded',status);
   // A refused heartbeat is settled like a lost commit: cancelled, finished by another owner (finalize), or lost.
   const renewed=await journal.heartbeat(lease);if(!renewed)return await settle(journalOf(await journal.status(),identity));
   if(renewed.generation!==lease.generation||renewed.token!==lease.token)throw Error('Checkpoint heartbeat returned another lease');lease=renewed;
   if(status.revision>=256)throw RangeError('Checkpoint journal revision budget exhausted before finish');
   let unit:MediaCheckpointUnit;
   try{unit=await component.process(state,head(status),signal);}catch(error){if(signal?.aborted)return result('aborted',status);throw error;}
   const {inputPosition,finished}=unit??{} as Partial<MediaCheckpointUnit>,output=unit?.output;
   if(!canonical(inputPosition)||typeof finished!=='boolean'||output!==null&&!(output instanceof Uint8Array))throw TypeError('Invalid checkpoint unit result');
   const previousInput=BigInt(status.inputPosition),nextInput=BigInt(inputPosition),bytes=output?.length??0,next={revision:status.revision+1,inputPosition,outputPosition:(BigInt(status.outputPosition)+BigInt(bytes)).toString()};
   if(nextInput<previousInput||!finished&&nextInput===previousInput&&bytes===0)throw TypeError('Checkpoint unit did not advance monotonically');
   if(bytes>maxObjectBytes)throw RangeError('Checkpoint unit output exceeds object byte limit');
   if(await component.verify(state,next)!==true)throw TypeError('Component counters disagree with unit positions');
   const serialized=component.serialize(state);if(signal?.aborted)return result('aborted',status);
   const descriptor=await prepareMediaCheckpoint(bucket,identity,lease,{...next,state:serialized,output:bytes?output!:null,finished},maxObjectBytes);
   let failure:unknown,acknowledged:MediaCheckpointStatus|null=null;
   for(let attempt=0;attempt<maxCommitAttempts&&!acknowledged;attempt++){
    if(attempt)commitRetries++;
    // The same descriptor and original lease make retry an exact replay.
    try{const value=journalOf(await journal.commit(lease,descriptor),identity)!;if(!contains(value,descriptor))throw Error('Checkpoint commit acknowledgement omits the descriptor');acknowledged=value;break;}catch(error){failure=error;}
    // Replay once before reading the journal; later failures inspect it for fencing.
    if(attempt===0&&maxCommitAttempts>1)continue;
    try{const current=journalOf(await journal.status(),identity);if(current&&contains(current,descriptor)){acknowledged=current;break;}if(!current||current.phase==='cancelled'||!holds(current,lease)||current.revision>=descriptor.revision)return settle(current);}catch(error){failure=new AggregateError([failure,error],'Checkpoint commit and journal inspection failed');}
   }
   if(!acknowledged)throw failure;
   units++;status=acknowledged;
   // A replay can observe later revisions committed by a newer owner.
   if(status.revision!==descriptor.revision)return settle(status);
   if(descriptor.finished)return await complete(status);
  }
 }finally{if(live)component.dispose?.(state as S);}
}
