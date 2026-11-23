import type {DurableObjectId} from '@cloudflare/workers-types';
import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
import type {MediaCheckpointStatus} from './types.js';
import type {MediaCheckpointWorkflowSpec} from './workflow-spec.js';
import {mediaCheckpointCoordinatorName,snapshotMediaCheckpointIdentity} from './state.js';
import {verifyMediaCheckpointWorkflowSpec} from './workflow-spec.js';

export interface MediaCheckpointWorkflowControlOptions {
 readonly workflow:{get(id:string):Promise<{terminate():Promise<void>;status():Promise<{readonly status:string}>}>};
 readonly CHECKPOINTS:{idFromName(name:string):DurableObjectId;get(id:DurableObjectId):{initialize(identity:ExecutionCheckpointIdentity):Promise<MediaCheckpointStatus>;cancel():Promise<MediaCheckpointStatus>}};
}
export interface MediaCheckpointWorkflowCancellationDetails {
 readonly workflowId:string;readonly specHash:string;readonly fenced:boolean;
 readonly journalPhase:'cancelled'|'finished'|null;readonly revision:number|null;
 readonly failures:readonly {readonly target:'journal'|'workflow';readonly message:string}[];
 readonly workflowStatus:string|null;readonly terminationConfirmed:boolean;
}
/** `cancelled`: fenced, then the instance was terminated or had already ended. `finished`: the journal
 * completed before the fence, so the instance is not terminated (that could only cut off finalization or
 * manifest publication) and nothing is rolled back; `workflowStatus` is its status as read. */
export type MediaCheckpointWorkflowCancellation={readonly workflowId:string;readonly specHash:string;readonly revision:number}&(
 {readonly journalPhase:'cancelled';readonly workflowStatus:'terminated'|'complete'|'errored'}|{readonly journalPhase:'finished';readonly workflowStatus:string});
/** A retry repeats the idempotent fence and reconciles termination. */
export class MediaCheckpointWorkflowCancellationError extends Error {
 constructor(readonly details:MediaCheckpointWorkflowCancellationDetails){super('Checkpoint workflow cancellation was not fully confirmed');this.name='MediaCheckpointWorkflowCancellationError';}
}
const terminal=(status:string):status is 'terminated'|'complete'|'errored'=>status==='terminated'||status==='complete'||status==='errored';
const message=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,2048);

/** Fence the checkpoint journal first, then terminate the platform instance.
 * The fence initializes an absent journal (so an unstarted or late instance observes
 * `cancelled`) and uses the coordinator's `cancel()`: an in-flight unit can no longer
 * heartbeat or commit. A journal that already finished stays finished and its instance is
 * left running to finalize or verify and publish its manifest. Platform terminate() alone
 * does not fence the journal. A failed fence never terminates.
 */
export async function cancelMediaCheckpointWorkflow(inputSpec:MediaCheckpointWorkflowSpec,options:MediaCheckpointWorkflowControlOptions):Promise<MediaCheckpointWorkflowCancellation>{
 const {workflow,CHECKPOINTS}=options,spec=await verifyMediaCheckpointWorkflowSpec(inputSpec),failures:{target:'journal'|'workflow';message:string}[]=[];
 const details=(fenced:boolean,status:MediaCheckpointStatus|null,workflowStatus:string|null,terminationConfirmed:boolean)=>({workflowId:spec.workflowId,specHash:spec.specHash,fenced,journalPhase:status&&(status.phase==='cancelled'||status.phase==='finished')?status.phase:null,revision:status?.revision??null,failures:Object.freeze([...failures]),workflowStatus,terminationConfirmed});
 let status:MediaCheckpointStatus|null=null;
 try{
  const journal=CHECKPOINTS.get(CHECKPOINTS.idFromName(await mediaCheckpointCoordinatorName(spec.identity)));
  await journal.initialize(spec.identity);status=await journal.cancel();
  if(!status||JSON.stringify(snapshotMediaCheckpointIdentity(status.identity))!==JSON.stringify(spec.identity)||status.phase!=='cancelled'&&status.phase!=='finished')throw Error('Checkpoint journal cancellation was not acknowledged');
 }catch(error){failures.push({target:'journal',message:message(error)});throw new MediaCheckpointWorkflowCancellationError(details(false,null,null,false));}
 let workflowStatus:string|null=null,terminationConfirmed=false;
 if(status.phase==='finished'){
  try{workflowStatus=(await (await workflow.get(spec.workflowId)).status()).status.slice(0,128);}catch(error){failures.push({target:'workflow',message:message(error)});}
  if(failures.length||workflowStatus===null)throw new MediaCheckpointWorkflowCancellationError(details(true,status,workflowStatus,false));
  return Object.freeze({workflowId:spec.workflowId,specHash:spec.specHash,journalPhase:'finished',revision:status.revision,workflowStatus});
 }
 try{
  const instance=await workflow.get(spec.workflowId);
  try{await instance.terminate();workflowStatus='terminated';terminationConfirmed=true;}
  catch(error){try{workflowStatus=(await instance.status()).status.slice(0,128);terminationConfirmed=terminal(workflowStatus);if(!terminationConfirmed)failures.push({target:'workflow',message:message(error)});}catch{failures.push({target:'workflow',message:message(error)});}}
 }catch(error){failures.push({target:'workflow',message:message(error)});}
 const ended=workflowStatus;if(failures.length||!terminationConfirmed||ended===null||!terminal(ended))throw new MediaCheckpointWorkflowCancellationError(details(true,status,ended,terminationConfirmed));
 return Object.freeze({workflowId:spec.workflowId,specHash:spec.specHash,journalPhase:'cancelled',revision:status.revision,workflowStatus:ended});
}
