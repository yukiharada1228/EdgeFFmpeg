import type {R2Bucket} from '@cloudflare/workers-types';
import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
import type {MediaCheckpointLease} from './types.js';
import type {MediaCheckpointComponent,MediaCheckpointJournal,MediaCheckpointRunResult,RunCheckpointedMediaUnitOptions} from './runner.js';
import {preflightCheckpointedMediaUnit,runCheckpointedMediaUnit} from './runner.js';
import type {MediaCheckpointWorkflowSpec} from './workflow-spec.js';
import {mediaCheckpointWorkflowStepGuardMs,verifyMediaCheckpointWorkflowSpec} from './workflow-spec.js';
import type {MediaCheckpointWorkflowManifest,MediaCheckpointWorkflowOutputBinding} from './workflow-result.js';
import {mediaCheckpointJournalDigest,publishVerifiedMediaCheckpointWorkflowResult,requireMediaCheckpointWorkflowDigest,tapMediaCheckpointWorkflowDestination} from './workflow-result.js';
import {snapshotMediaCheckpointIdentity} from './state.js';

export interface MediaCheckpointWorkflowContext {readonly spec:MediaCheckpointWorkflowSpec;readonly bucket:R2Bucket}
/** Live media objects for one verified spec; recreated in every step, never persisted. The output part
 * (`filesystem` resolving `spec.output.path`, optional finalize `patches`) is the same one
 * `publishMediaCheckpointWorkflowResult` verifies a destination with.
 */
export interface MediaCheckpointWorkflowBinding extends MediaCheckpointWorkflowOutputBinding {readonly component:MediaCheckpointComponent<unknown>}
/** Registered by name in the Worker. `implementationVersion` must equal the spec identity's. */
export interface MediaCheckpointWorkflowComponent {
 readonly implementationVersion:string;
 bind(context:MediaCheckpointWorkflowContext):MediaCheckpointWorkflowBinding|Promise<MediaCheckpointWorkflowBinding>;
}
export type MediaCheckpointComponentRegistry=ReadonlyMap<string,MediaCheckpointWorkflowComponent>;
export interface MediaCheckpointWorkflowDependencies {
 readonly bucket:R2Bucket;readonly components:MediaCheckpointComponentRegistry;
 readonly journal:(identity:ExecutionCheckpointIdentity)=>MediaCheckpointJournal|Promise<MediaCheckpointJournal>;
}
export interface MediaCheckpointWorkflowStepConfig {readonly retries:{readonly limit:number;readonly delay:number;readonly backoff?:'constant'|'linear'|'exponential'};readonly timeout:number}
/** The engine's per-attempt step context; `attempt` is 1 for the first execution of a step. */
export interface MediaCheckpointWorkflowStepContext {readonly attempt:number}
/** The subset of `WorkflowStep` the driver uses. Step names are a pure function of earlier step results.
 * A step that passes no context is treated as a possible duplicate execution (no lease handoff).
 */
export interface MediaCheckpointWorkflowStep {
 do<T>(name:string,config:MediaCheckpointWorkflowStepConfig,callback:(context?:MediaCheckpointWorkflowStepContext)=>Promise<T>):Promise<T>;
 /** A durable sleep keyed by name and duration; both come from a persisted step result, so a replay is stable. */
 sleep(name:string,duration:number):Promise<void>;
}
export type MediaCheckpointWorkflowEnd='cancelled'|'lease-lost'|'output-conflict'|'failed'|'exhausted';
/** Compact persisted result of one durable unit step (never the whole journal). */
export type MediaCheckpointWorkflowUnit=
 {readonly outcome:'yielded';readonly revision:number|null;readonly units:number;readonly lease:MediaCheckpointLease|null}|
 {readonly outcome:'busy';readonly revision:number|null;readonly wakeAt:number;readonly sleepMs:number}|
 {readonly outcome:'finished';readonly revision:number;readonly bytes:string;readonly sha256:string;readonly existing:boolean;readonly journalSha256:string}|
 {readonly outcome:Exclude<MediaCheckpointWorkflowEnd,'exhausted'>;readonly revision:number|null;readonly message:string};
/** Deterministic end. Thrown outside every step, so the instance errors without a platform retry. */
export class MediaCheckpointWorkflowError extends Error {
 constructor(readonly outcome:MediaCheckpointWorkflowEnd,readonly revision:number|null,detail:string){super(`Checkpoint workflow ended with ${outcome}${revision===null?'':' at revision '+revision}: ${detail}`);this.name='MediaCheckpointWorkflowError';}
}
export interface MediaCheckpointWorkflowInvocation {
 /** Lease an earlier invocation of this owner yielded. Pass it only once every execution that used it has
  * settled: the coordinator cannot tell two live holders of one lease apart (see `resumeLease`). */
 readonly lease?:MediaCheckpointLease|null;
 /** Stops the invocation at a unit boundary or during finalization; a stopped invocation is persisted as `yielded`. */
 readonly signal?:AbortSignal;
 /** Receives every lease this invocation claims or renews. */
 readonly observe?:(lease:MediaCheckpointLease)=>void;
}
const encoder=new TextEncoder();
const validationConfig={retries:{limit:0,delay:100},timeout:30000} as const;
const operationConfig={retries:{limit:3,delay:100,backoff:'exponential'},timeout:30000} as const;
const message=(error:unknown):string=>(error instanceof AggregateError?error.message+': '+error.errors.map(message).join('; '):String(error instanceof Error?error.message:error)).slice(0,2048);
/** Configuration, limit and component contract violations are deterministic; any other runner or provider failure is retried. */
export const retryableMediaCheckpointWorkflowError=(error:unknown)=>!(error instanceof TypeError||error instanceof RangeError);
async function bind(spec:MediaCheckpointWorkflowSpec,deps:MediaCheckpointWorkflowDependencies):Promise<MediaCheckpointWorkflowBinding>{
 const entry=deps.components.get(spec.component);
 if(!entry||typeof entry.bind!=='function')throw TypeError('Unregistered checkpoint workflow component: '+spec.component);
 if(entry.implementationVersion!==spec.identity.implementationVersion)throw TypeError('Checkpoint workflow component implementation version mismatch');
 const binding=await entry.bind({spec,bucket:deps.bucket});if(!binding||typeof binding!=='object')throw TypeError('Invalid checkpoint workflow component binding');
 return binding;
}
function runnerOptions(spec:MediaCheckpointWorkflowSpec,deps:MediaCheckpointWorkflowDependencies,binding:MediaCheckpointWorkflowBinding,journal:MediaCheckpointJournal,lease:MediaCheckpointLease|null,signal?:AbortSignal):RunCheckpointedMediaUnitOptions<unknown>{
 const policy=spec.policy,output=spec.output;
 return {bucket:deps.bucket,journal,identity:spec.identity,component:binding.component,leaseMs:policy.leaseMs,maxUnits:policy.unitsPerInvocation,maxObjectBytes:policy.maxObjectBytes,maxCommitAttempts:policy.maxCommitAttempts,...(lease?{resumeLease:lease}:{}),...(signal?{signal}:{}),
  finalize:{filesystem:binding.filesystem,path:output.path,overwrite:output.overwrite,maxWriteBytes:output.maxWriteBytes,maxReadBytes:output.maxReadBytes,...(binding.patches===undefined?{}:{patches:binding.patches}),...(binding.maxPatches===undefined?{}:{maxPatches:binding.maxPatches}),...(binding.maxPatchBytes===undefined?{}:{maxPatchBytes:binding.maxPatchBytes})}};
}
// Another config, input generation or implementation version for the same job and WorkUnit never converges.
async function identityConflict(journal:MediaCheckpointJournal,identity:ExecutionCheckpointIdentity):Promise<boolean>{
 try{const recorded=await journal.status();return recorded!==null&&JSON.stringify(snapshotMediaCheckpointIdentity(recorded.identity))!==JSON.stringify(snapshotMediaCheckpointIdentity(identity));}catch{return false;}
}
const detail:Record<Exclude<MediaCheckpointRunResult['outcome'],'finished'|'yielded'|'busy'|'output-conflict'|'aborted'>,string>={cancelled:'checkpoint journal is cancelled','lease-lost':'another owner holds or advanced the checkpoint journal, or a unit outran its lease'};
/** One bounded runner invocation, resuming `options.lease` when the previous step yielded with it.
 * Retryable failures are thrown for the step's bounded platform retries; everything else becomes a
 * compact, persisted outcome. A finished result carries the size and SHA-256 of exactly the bytes
 * finalization published or verified at the destination.
 */
export async function invokeMediaCheckpointWorkflowUnit(spec:MediaCheckpointWorkflowSpec,deps:MediaCheckpointWorkflowDependencies,options:MediaCheckpointWorkflowInvocation={}):Promise<MediaCheckpointWorkflowUnit>{
 const {lease=null,signal,observe}=options;let run:MediaCheckpointRunResult,destination:ReturnType<typeof tapMediaCheckpointWorkflowDestination>;
 try{
  const binding=await bind(spec,deps),journal=await deps.journal(spec.identity);destination=tapMediaCheckpointWorkflowDestination(binding.filesystem);
  const tracked:MediaCheckpointJournal={
   initialize:async identity=>{try{return await journal.initialize(identity);}catch(error){if(await identityConflict(journal,identity))throw TypeError('Checkpoint workflow identity conflicts with the journal recorded for this job and WorkUnit');throw error;}},
   status:()=>journal.status(),commit:(owner,descriptor)=>journal.commit(owner,descriptor),
   claim:async leaseMs=>{const claim=await journal.claim(leaseMs);if(claim)observe?.({...claim.lease});return claim;},heartbeat:async owner=>{const renewed=await journal.heartbeat(owner);if(renewed)observe?.({...renewed});return renewed;}};
  run=await runCheckpointedMediaUnit(runnerOptions(spec,deps,{...binding,filesystem:destination.files},tracked,lease,signal));
 }
 catch(error){if(retryableMediaCheckpointWorkflowError(error))throw error;return {outcome:'failed',revision:null,message:message(error)};}
 const status=run.status,revision=status?.revision??null;
 // An aborted invocation stopped at a committed boundary (or before finalizing); it continues like a yield.
 if(run.outcome==='yielded'||run.outcome==='aborted')return {outcome:'yielded',revision,units:run.units,lease:status?.lease?{generation:status.lease.generation,token:status.lease.token,expiresAt:status.lease.expiresAt}:null};
 // Wait for the reported foreign lease to expire; a margin absorbs clock skew between the engine and the journal.
 // The duration is fixed here: an engine replaying the instance must not see a sleep relative to a later clock (a past timestamp).
 if(run.outcome==='busy'){const now=Date.now(),wakeAt=Math.max(status?.lease?.expiresAt??0,now)+spec.policy.pollIntervalMs;return {outcome:'busy',revision,wakeAt,sleepMs:wakeAt-now};}
 if(run.outcome==='finished'){if(!status||!run.finalized)throw Error('Finished checkpoint invocation lacks a verified destination');const existing=run.finalized.existing===true;return {outcome:'finished',revision:status.revision,bytes:run.finalized.bytes.toString(),sha256:await destination.digest(existing),existing,journalSha256:await mediaCheckpointJournalDigest(status)};}
 if(run.outcome==='output-conflict'){const conflict=run.conflict;return {outcome:'output-conflict',revision,message:conflict?`${conflict.path} holds ${conflict.actual.bytes} bytes (sha256 ${conflict.actual.sha256??'unread'}); journal assembles ${conflict.expected.bytes} bytes (sha256 ${conflict.expected.sha256??'unread'})`:'checkpoint output destination conflict'};}
 return {outcome:run.outcome,revision,message:detail[run.outcome]};
}
/** Drive one checkpointed WorkUnit to a published, verified result.
 *
 * `validate` (no retries) verifies hashes, resolves the registry entry and preflights the runner.
 * Each `unit-<n>` step performs one bounded invocation: `yielded` continues with the same lease,
 * `busy` sleeps until the reported lease expiry, retryable errors use the step's bounded retries,
 * and `cancelled`, `lease-lost`, `output-conflict` or a deterministic failure end the instance.
 * Every attempt stops itself one lease plus a guard before the step timeout, and a lease is handed
 * only to an execution no other execution can still be using. After `finished`, `publish` writes the
 * immutable manifest of the re-read journal and the destination content that step established.
 */
export async function runMediaCheckpointWorkflow(event:{readonly instanceId:string;readonly payload:MediaCheckpointWorkflowSpec},step:MediaCheckpointWorkflowStep,deps:MediaCheckpointWorkflowDependencies):Promise<MediaCheckpointWorkflowManifest>{
 const payload=event.payload;
 if(!payload||event.instanceId!==payload.workflowId)throw Error('Checkpoint workflow instance identity mismatch');
 if(encoder.encode(JSON.stringify(payload)).length>65536)throw RangeError('Checkpoint workflow request byte limit exceeded');
 const spec=await step.do('validate-checkpoint-workflow',validationConfig,async()=>{
  const spec=await verifyMediaCheckpointWorkflowSpec(payload);requireMediaCheckpointWorkflowDigest();
  preflightCheckpointedMediaUnit(runnerOptions(spec,deps,await bind(spec,deps),await deps.journal(spec.identity),null));return spec;
 });
 const policy=spec.policy,unitConfig={retries:{limit:policy.maxRetries,delay:policy.retryDelayMs,backoff:'exponential' as const},timeout:policy.stepTimeoutMs};
 // The unit in flight at the deadline still fits its lease, so a stopped attempt settles before the platform timeout.
 const deadlineMs=policy.stepTimeoutMs-policy.leaseMs-mediaCheckpointWorkflowStepGuardMs;
 let lease:MediaCheckpointLease|null=null;
 // Busy sleeps share the budget, so an instance never exceeds maxInvocations + 2 steps.
 for(let invocation=0,steps=0;steps<policy.maxInvocations;invocation++){
  steps++;
  // Handoff never reaches a lease another execution may still use: the settled previous step's lease goes to the
  // engine's first attempt only, and a retry resumes the newest lease of an attempt of this step that settled in this
  // run while none is live here. Any other attempt claims, and sees `busy` while an abandoned holder still renews.
  const handoff:MediaCheckpointLease|null=lease;let started=false,live=0,settled:MediaCheckpointLease|null|undefined;
  const unit:MediaCheckpointWorkflowUnit=await step.do(`unit-${invocation}`,unitConfig,async(context):Promise<MediaCheckpointWorkflowUnit>=>{
   const resume:MediaCheckpointLease|null=live?null:settled!==undefined?settled:context?.attempt===1&&!started?handoff:null,controller=new AbortController();let newest=resume;started=true;live++;
   const timer=setTimeout(()=>controller.abort(Error('Checkpoint workflow step deadline reached')),deadlineMs);
   try{return await invokeMediaCheckpointWorkflowUnit(spec,deps,{lease:resume,signal:controller.signal,observe:next=>{newest=next;}});}
   finally{clearTimeout(timer);live--;settled=newest;}
  });
  lease=unit.outcome==='yielded'?unit.lease:null;
  if(unit.outcome==='yielded')continue;
  if(unit.outcome==='busy'){if(steps>=policy.maxInvocations)break;steps++;await step.sleep(`busy-${invocation}`,unit.sleepMs);continue;}
  if(unit.outcome==='finished')return await step.do('publish-checkpoint-workflow-result',operationConfig,async()=>{
   const status=await (await deps.journal(spec.identity)).status();
   if(!status||status.phase!=='finished'||status.revision!==unit.revision||await mediaCheckpointJournalDigest(status)!==unit.journalSha256)throw Error('Finished checkpoint journal changed before result publication');
   return publishVerifiedMediaCheckpointWorkflowResult(deps.bucket,spec,status,{bytes:unit.bytes,sha256:unit.sha256});
  });
  throw new MediaCheckpointWorkflowError(unit.outcome,unit.revision,unit.message);
 }
 throw new MediaCheckpointWorkflowError('exhausted',null,'invocation budget exhausted');
}
