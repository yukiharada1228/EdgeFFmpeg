import type {MessageBatch,R2Bucket} from '@cloudflare/workers-types';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaJobArtifacts} from './artifacts.js';
import {mediaJobArtifactPrefix} from './types.js';
import {snapshotMediaJobSpec} from './state.js';
import type {MediaJobCoordinatorClient,MediaJobLease,MediaJobMessage,MediaJobSpec,MediaJobStatus} from './types.js';

export interface MediaJobExecutorOptions {
 readonly bucket:R2Bucket;
 readonly backend:()=>ExecutionBackend;
 readonly implementationVersion:string;
 readonly maxReadBytes?:number;readonly maxWriteBytes?:number;readonly maxOutputBytes?:number;
 readonly signal?:AbortSignal;
}
export interface ExecuteMediaJobOptions extends MediaJobExecutorOptions {readonly coordinator:MediaJobCoordinatorClient;readonly spec:MediaJobSpec;readonly lease:MediaJobLease}
export interface RunMediaJobOptions extends MediaJobExecutorOptions {readonly coordinatorFor:(jobId:string)=>MediaJobCoordinatorClient}
export interface MediaJobExecutionOutcome {readonly kind:'terminal'|'busy'|'retry';readonly status:MediaJobStatus|null}
const terminal=(status:MediaJobStatus|null)=>status!==null&&['succeeded','failed','cancelled'].includes(status.phase);
const outcome=(status:MediaJobStatus|null):MediaJobExecutionOutcome=>({kind:terminal(status)?'terminal':'retry',status});
const boundedError=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,2048);

/** Execute a complete command under one fenced lease. Retries replay from the
 * beginning; no codec or filter checkpoint is represented by this interface.
 */
export async function executeMediaJob(options:ExecuteMediaJobOptions):Promise<MediaJobExecutionOutcome> {
 const spec=snapshotMediaJobSpec(options.spec),coordinator=options.coordinator;
 let lease={...options.lease};const controller=new AbortController(),signal=controller.signal;
 const abort=()=>controller.abort(options.signal?.reason);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 const fence=async()=>{signal.throwIfAborted();if(!await coordinator.check(lease)){controller.abort(Error('Media job lease was lost or cancelled'));signal.throwIfAborted();}signal.throwIfAborted();};
 let timer:ReturnType<typeof setTimeout>|undefined,deadline:ReturnType<typeof setTimeout>|undefined,renewing:Promise<void>|undefined,closed=false;
 const renew=()=>{timer=setTimeout(()=>{renewing=(async()=>{try{const next=await coordinator.heartbeat(lease);if(!next)controller.abort(Error('Media job lease renewal rejected'));else lease={...next};}catch(error){controller.abort(error);}finally{if(!closed&&!signal.aborted)renew();}})();},Math.max(10,Math.floor(spec.leaseMs/3)));};
 let artifacts:ReturnType<typeof createMediaJobArtifacts>|undefined;
 try {
  if(spec.implementationVersion!==options.implementationVersion)throw Error('Media job implementation version mismatch');
  for(const value of [options.maxReadBytes,options.maxWriteBytes,options.maxOutputBytes])if(value!==undefined&&(!Number.isSafeInteger(value)||value<1))throw RangeError('Invalid media job I/O limits');
  const maxReadBytes=Math.min(options.maxReadBytes??65536,65536,spec.budget.maxBufferBytes),maxWriteBytes=Math.min(options.maxWriteBytes??65536,65536,spec.budget.maxBufferBytes),maxOutputBytes=options.maxOutputBytes??67108864;
  if(maxOutputBytes>5242880*10000)throw RangeError('Media job output limit exceeds multipart capacity');
  // Storage buffering is outside the media backend. Subtract a conservative
  // envelope before execution, including simultaneous small-buffer promotion.
  // This bounds owned I/O allocations; it is not a runtime heap measurement.
  const ioBytes=spec.outputs.length*(Math.min(5242880,maxOutputBytes)+4096)+spec.inputs.length*maxReadBytes+maxWriteBytes;
  const mediaBudget={...spec.budget,maxResidentBytes:spec.budget.maxResidentBytes-ioBytes};
  if(mediaBudget.maxResidentBytes<mediaBudget.maxBufferBytes)throw RangeError('Media job budget cannot cover bounded R2 I/O and media buffers');
  await fence();
  // Conservative wall bound using the submitted execution budget; this does
  // not measure CPU time or preempt a noncooperative synchronous backend.
  deadline=setTimeout(()=>controller.abort(Error('Media job wall time budget exceeded')),spec.budget.maxCpuTimeMs);
  renew();
  artifacts=createMediaJobArtifacts({bucket:options.bucket,spec,prefix:mediaJobArtifactPrefix(spec.jobId,lease),signal,fence,maxReadBytes,maxWriteBytes,maxOutputBytes});
  await artifacts.validateInputs();
  const ffmpeg=new FFmpeg({filesystem:artifacts.filesystem,backend:options.backend(),budget:mediaBudget});
  const result=await ffmpeg.exec(spec.args,{signal});
  if(result.exitCode!==0)throw result.error??Error(result.diagnostics.map(item=>item.message).join('; ')||'Media job command failed');
  if(result.outputs.length!==spec.outputs.length||spec.outputs.some(output=>!result.outputs.includes(output.path)))throw Error('Media job output set differs from submitted command');
  const completed=await artifacts.artifacts();await artifacts.validateInputs();await fence();
  return outcome(await coordinator.succeed(lease,completed));
 }catch(error){
  // Failure and completion are fenced by the same coordinator. If an RPC reply
  // is lost, a later delivery resolves status instead of deleting private keys.
  try {return outcome(await coordinator.fail(lease,boundedError(error),{retryable:!options.signal?.aborted}));}
  catch {
   // A stale fail can follow cancellation, another winner, or a lost success
   // reply. Reconcile without mutating/deleting any immutable attempt artifact.
   try{return outcome(await coordinator.status());}catch{throw error;}
  }
 }finally{
  closed=true;if(timer!==undefined)clearTimeout(timer);if(deadline!==undefined)clearTimeout(deadline);options.signal?.removeEventListener('abort',abort);
  await renewing;await artifacts?.close();
 }
}

/** A duplicate running delivery is retried; terminal deliveries are harmless. */
export async function runMediaJob(jobId:string,options:RunMediaJobOptions):Promise<MediaJobExecutionOutcome>{
 const coordinator=options.coordinatorFor(jobId),claim=await coordinator.claim();
 if(!claim){const status=await coordinator.status();return {kind:terminal(status)?'terminal':'busy',status};}
 return executeMediaJob({...options,coordinator,...claim});
}

/** Sequential per-batch dispatch bounds active decoders and multipart buffers.
 * Cloudflare Queue consumers can scale batches independently across isolates.
 */
export async function consumeMediaJobs(batch:Pick<MessageBatch<MediaJobMessage>,'messages'>,options:RunMediaJobOptions):Promise<void>{
 for(const message of batch.messages){
  if(!message.body||typeof message.body.jobId!=='string'||message.body.jobId.length<1||message.body.jobId.length>128){message.ack();continue;}
  try{const result=await runMediaJob(message.body.jobId,options);if(result.kind==='terminal')message.ack();else message.retry({delaySeconds:1});}
  catch{message.retry({delaySeconds:1});}
 }
}
