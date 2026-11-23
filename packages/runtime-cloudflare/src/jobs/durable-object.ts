import {DurableObject} from 'cloudflare:workers';
import type {DurableObjectState,DurableObjectNamespace,Queue} from '@cloudflare/workers-types';
import type {MediaJobArtifact,MediaJobClaim,MediaJobCoordinatorClient,MediaJobLease,MediaJobMessage,MediaJobSpec,MediaJobStatus,MediaJobWorkflowIdentity} from './types.js';
import type {StoredMediaJob} from './state.js';
import {cancelMediaJobWorkflow,mediaJobWorkflowId,snapshotMediaJobWorkflowIdentity,submitFencedMediaJob,cancelMediaJob,claimMediaJob,dispatchRetryMs,expireMediaJob,failMediaJob,heartbeatMediaJob,succeedMediaJob,validMediaJobLease} from './state.js';

export interface MediaJobCoordinatorEnvironment {readonly JOBS:Pick<DurableObjectNamespace,'idFromName'>;readonly MEDIA_JOB_QUEUE:Queue<MediaJobMessage>}
/** One SQLite-backed object per job. All state and alarm updates are atomic;
 * queue delivery is a durable, repeating outbox until an execution is claimed.
 */
export class MediaJobCoordinator extends DurableObject<MediaJobCoordinatorEnvironment> implements MediaJobCoordinatorClient {
 constructor(ctx:DurableObjectState,env:MediaJobCoordinatorEnvironment){
  super(ctx,env);
  this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS media_job (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');
  this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS media_workflow_cancel (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL)');
 }
 private async transition<T>(action:(job:StoredMediaJob|null,now:number,fence:MediaJobWorkflowIdentity|null)=>{job:StoredMediaJob|null;result:T;fence?:MediaJobWorkflowIdentity}):Promise<T>{
  return this.ctx.storage.transaction(async()=>{
   const row=this.ctx.storage.sql.exec<{payload:string}>('SELECT payload FROM media_job WHERE id=1').toArray()[0];
   const current=row?JSON.parse(row.payload) as StoredMediaJob:null;
   const cancelled=this.ctx.storage.sql.exec<{owner:string}>('SELECT owner FROM media_workflow_cancel WHERE id=1').toArray()[0];
   const existingFence=cancelled?JSON.parse(cancelled.owner) as MediaJobWorkflowIdentity:null;
   const {job,result,fence}=action(current,Date.now(),existingFence);
   if(fence)this.ctx.storage.sql.exec('INSERT INTO media_workflow_cancel (id,owner) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner',JSON.stringify(fence));
   if(job)this.ctx.storage.sql.exec('INSERT INTO media_job (id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',JSON.stringify(job));
   // SQLite storage.transaction includes both SQL and alarm state. No queue/R2
   // I/O is awaited here, so a restart cannot leave a committed job unarmed.
   if(job?.nextDispatchAt!==null&&job?.nextDispatchAt!==undefined)await this.ctx.storage.setAlarm(job.nextDispatchAt);
   else await this.ctx.storage.deleteAlarm();
   return result;
  });
 }
 async submit(spec:MediaJobSpec):Promise<MediaJobStatus>{
  if(!this.ctx.id.equals(this.env.JOBS.idFromName(spec.jobId)))throw new Error('Media job namespace identity mismatch');
  return this.transition((previous,now,fence)=>{const job=submitFencedMediaJob(previous,spec,now,fence);return {job,result:job.status};});
 }
 /** Cancel an expected immutable submission, even if its first delivery is late. */
 async cancelSubmitted(spec:MediaJobSpec):Promise<MediaJobStatus>{
  if(!this.ctx.id.equals(this.env.JOBS.idFromName(spec.jobId)))throw new Error('Media job namespace identity mismatch');
  return this.transition((previous,now,fence)=>{const job=cancelMediaJob(submitFencedMediaJob(previous,spec,now,fence));return {job,result:job.status};});
 }
 /** Fence every node of one immutable workflow, including not-yet-derived jobs. */
 async cancelWorkflowNode(owner:MediaJobWorkflowIdentity):Promise<MediaJobStatus|null>{
  const snapshot=snapshotMediaJobWorkflowIdentity(owner);
  if(!this.ctx.id.equals(this.env.JOBS.idFromName(mediaJobWorkflowId(snapshot))))throw new Error('Media job namespace identity mismatch');
  return this.transition((previous,_now,fence)=>{
   const cancelled=cancelMediaJobWorkflow(previous,snapshot,fence);
   return {...cancelled,result:cancelled.job?.status??null};
  });
 }
 async claim():Promise<MediaJobClaim|null>{
  return this.transition((previous,now)=>{if(!previous)return {job:null,result:null};const {job,claim}=claimMediaJob(previous,now,crypto.randomUUID());return {job,result:claim};});
 }
 async heartbeat(lease:MediaJobLease):Promise<MediaJobLease|null>{
  return this.transition((previous,now)=>{if(!previous)return {job:null,result:null};const result=heartbeatMediaJob(previous,lease,now);return {job:result.job,result:result.lease};});
 }
 async check(lease:MediaJobLease):Promise<boolean>{
  return this.transition((previous,now)=>{if(!previous)return {job:null,result:false};const job=expireMediaJob(previous,now);return {job,result:validMediaJobLease(job,lease,now)};});
 }
 async cancel():Promise<MediaJobStatus>{
  return this.transition(previous=>{if(!previous)throw new Error('Unknown media job');const job=cancelMediaJob(previous);return {job,result:job.status};});
 }
 async succeed(lease:MediaJobLease,artifacts:readonly MediaJobArtifact[]):Promise<MediaJobStatus>{
  return this.transition((previous,now)=>{if(!previous)throw new Error('Unknown media job');const job=succeedMediaJob(previous,lease,artifacts,now);return {job,result:job.status};});
 }
 async fail(lease:MediaJobLease,error:string,options:{readonly retryable:boolean}):Promise<MediaJobStatus>{
  return this.transition((previous,now)=>{if(!previous)throw new Error('Unknown media job');const job=failMediaJob(previous,lease,error,options.retryable,now);return {job,result:job.status};});
 }
 async status():Promise<MediaJobStatus|null>{
  return this.transition((previous,now)=>{const job=previous?expireMediaJob(previous,now):null;return {job,result:job?.status??null};});
 }
 async alarm():Promise<void>{
  const message=await this.transition<MediaJobMessage|null>((previous,now)=>{
   if(!previous)return {job:null,result:null};
   let job=expireMediaJob(previous,now);
   if(job.status.phase!=='queued'||job.nextDispatchAt===null||job.nextDispatchAt>now)return {job,result:null};
   job={...job,nextDispatchAt:now+dispatchRetryMs};
   return {job,result:{jobId:job.status.spec.jobId}};
  });
  // The repeating alarm was persisted before this external await. Failed or
  // duplicate sends cannot orphan work, and an expired lease is re-enqueued.
  if(message)await this.env.MEDIA_JOB_QUEUE.send(message);
 }
}
