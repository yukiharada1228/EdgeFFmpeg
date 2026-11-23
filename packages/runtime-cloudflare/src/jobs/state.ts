import type {MediaJobArtifact,MediaJobClaim,MediaJobLease,MediaJobSpec,MediaJobStatus,MediaJobWorkflowIdentity} from './types.js';
import {mediaJobArtifactPrefix} from './types.js';

export interface StoredMediaJob {readonly status:MediaJobStatus;readonly identity:string;readonly nextDispatchAt:number|null;readonly completedLease:MediaJobLease|null}
export const dispatchRetryMs=30000;
const fail=(message:string):never=>{throw new Error(message);};
const integer=(value:number,min:number,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const text=(value:string,max=4096)=>typeof value==='string'&&value.length>0&&value.length<=max;
const path=(value:string)=>text(value)&&value.startsWith('/')&&!value.includes('\\')&&!value.includes('\0')&&value.slice(1).split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
const key=(value:string)=>text(value,2048)&&!value.startsWith('/')&&!value.includes('\\')&&!value.includes('\0')&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
export function snapshotMediaJobWorkflowIdentity(owner:MediaJobWorkflowIdentity):MediaJobWorkflowIdentity {
 if(!owner||typeof owner.workflowId!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(owner.workflowId)||typeof owner.nodeId!=='string'||!/^[A-Za-z0-9_-]{1,48}$/.test(owner.nodeId)||typeof owner.graphHash!=='string'||!/^[a-f0-9]{64}$/.test(owner.graphHash))fail('Invalid media job workflow identity');
 return {workflowId:owner.workflowId,graphHash:owner.graphHash,nodeId:owner.nodeId};
}
export function mediaJobWorkflowId(owner:MediaJobWorkflowIdentity):string {
 const value=snapshotMediaJobWorkflowIdentity(owner);
 return `wf-${value.workflowId.length}-${value.workflowId}-${value.nodeId}`;
}
function sameWorkflow(a:MediaJobWorkflowIdentity|undefined,b:MediaJobWorkflowIdentity):boolean {
 return a!==undefined&&a.workflowId===b.workflowId&&a.graphHash===b.graphHash&&a.nodeId===b.nodeId;
}
/** Fixed property order makes retried submit identity independent of object order. */
export function snapshotMediaJobSpec(spec:MediaJobSpec):MediaJobSpec {
 if(spec.version!==1||spec.workUnitId!=='command'||typeof spec.jobId!=='string'||!/^[-_A-Za-z0-9]{1,128}$/.test(spec.jobId)||![spec.graphHash,spec.inputFingerprint].every(value=>/^[a-f0-9]{64}$/.test(value))||!text(spec.implementationVersion,256))fail('Invalid media job identity');
 if(!Array.isArray(spec.args)||spec.args.length<1||spec.args.length>1024||!spec.args.every(value=>typeof value==='string'&&value.length<=4096&&!value.includes('\0'))||spec.args.reduce((size,value)=>size+new TextEncoder().encode(value).length,0)>65536)fail('Invalid media job arguments');
 if(!Array.isArray(spec.inputs)||spec.inputs.length<1||spec.inputs.length>16||!Array.isArray(spec.outputs)||spec.outputs.length<1||spec.outputs.length>16)fail('Invalid media job file count');
 const workflow=spec.workflow===undefined?undefined:snapshotMediaJobWorkflowIdentity(spec.workflow);
 if(workflow&&mediaJobWorkflowId(workflow)!==spec.jobId)fail('Media job workflow namespace identity mismatch');
 const names=new Set<string>();
 const inputs=spec.inputs.map(input=>{if(!path(input.path)||names.has(input.path)||!key(input.key)||![input.etag,input.version].every(value=>text(value))||!integer(input.size,0))fail('Invalid pinned media job input');names.add(input.path);return {path:input.path,key:input.key,etag:input.etag,version:input.version,size:input.size};});
 const outputs=spec.outputs.map(output=>{if(!path(output.path)||names.has(output.path))fail('Invalid media job output');names.add(output.path);return {path:output.path};});
 const b=spec.budget;if(!b||![b.maxResidentBytes,b.maxBufferBytes,b.maxCpuTimeMs,b.maxPendingPackets].every(value=>integer(value,1))||b.maxBufferBytes>b.maxResidentBytes)fail('Invalid media job budget');
 if(!integer(spec.maxAttempts,1,100)||!integer(spec.leaseMs,10,300000))fail('Invalid media job retry policy');
 return {version:1,jobId:spec.jobId,workUnitId:'command',...(workflow?{workflow}:{}),graphHash:spec.graphHash,inputFingerprint:spec.inputFingerprint,implementationVersion:spec.implementationVersion,args:[...spec.args],inputs,outputs,budget:{maxResidentBytes:b.maxResidentBytes,maxBufferBytes:b.maxBufferBytes,maxCpuTimeMs:b.maxCpuTimeMs,maxPendingPackets:b.maxPendingPackets},maxAttempts:spec.maxAttempts,leaseMs:spec.leaseMs};
}
export function submitMediaJob(previous:StoredMediaJob|null,spec:MediaJobSpec,now:number):StoredMediaJob {
 const snapshot=snapshotMediaJobSpec(spec),identity=JSON.stringify(snapshot);
 if(previous){if(previous.identity!==identity)fail('Media job immutable spec conflict');return previous;}
 return {status:{spec:snapshot,phase:'queued',generation:0,attempts:0,lease:null,artifacts:[],error:null},identity,nextDispatchAt:now,completedLease:null};
}
export function expireMediaJob(job:StoredMediaJob,now:number):StoredMediaJob {
 const status=job.status;
 if(status.phase!=='running'||!status.lease||status.lease.expiresAt>now)return job;
 const retry=status.attempts<status.spec.maxAttempts;
 return {...job,status:{...status,phase:retry?'queued':'failed',lease:null,error:'Media job lease expired'},nextDispatchAt:retry?now:null};
}
export function validMediaJobLease(job:StoredMediaJob,lease:MediaJobLease,now:number):boolean {
 const current=job.status.lease;
 return job.status.phase==='running'&&current!==null&&current.generation===lease.generation&&current.token===lease.token&&current.expiresAt>now;
}
export function claimMediaJob(original:StoredMediaJob,now:number,token:string):{job:StoredMediaJob;claim:MediaJobClaim|null}{
 const job=expireMediaJob(original,now),status=job.status;
 if(status.phase!=='queued')return {job,claim:null};
 const lease={generation:status.generation+1,token,expiresAt:now+status.spec.leaseMs};
 const next={...job,status:{...status,phase:'running' as const,generation:lease.generation,attempts:status.attempts+1,lease,error:null},nextDispatchAt:lease.expiresAt};
 return {job:next,claim:{spec:status.spec,lease}};
}
export function heartbeatMediaJob(job:StoredMediaJob,lease:MediaJobLease,now:number):{job:StoredMediaJob;lease:MediaJobLease|null}{
 if(!validMediaJobLease(job,lease,now))return {job:expireMediaJob(job,now),lease:null};
 const renewed={...job.status.lease!,expiresAt:now+job.status.spec.leaseMs};
 return {job:{...job,status:{...job.status,lease:renewed},nextDispatchAt:renewed.expiresAt},lease:renewed};
}
export function cancelMediaJob(job:StoredMediaJob):StoredMediaJob {
 if(['succeeded','failed','cancelled'].includes(job.status.phase))return job;
 return {...job,status:{...job.status,phase:'cancelled',lease:null,error:null},nextDispatchAt:null};
}
function snapshotArtifacts(job:StoredMediaJob,lease:MediaJobLease,artifacts:readonly MediaJobArtifact[]):readonly MediaJobArtifact[]{
 if(!Array.isArray(artifacts)||artifacts.length!==job.status.spec.outputs.length)fail('Invalid media job artifact count');
 const expected=new Set(job.status.spec.outputs.map(output=>output.path)),prefix=mediaJobArtifactPrefix(job.status.spec.jobId,lease);
 const result=artifacts.map(artifact=>{
  if(!expected.delete(artifact.path)||!key(artifact.key)||!artifact.key.startsWith(prefix)||artifact.key.length===prefix.length||![artifact.etag,artifact.version].every(value=>text(value))||!integer(artifact.size,0))fail('Invalid immutable media job artifact');
  return {path:artifact.path,key:artifact.key,etag:artifact.etag,version:artifact.version,size:artifact.size};
 });
 return result.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export function succeedMediaJob(job:StoredMediaJob,lease:MediaJobLease,artifacts:readonly MediaJobArtifact[],now:number):StoredMediaJob {
 const copied=snapshotArtifacts(job,lease,artifacts);
 if(job.status.phase==='succeeded'&&job.completedLease?.generation===lease.generation&&job.completedLease.token===lease.token){
  if(JSON.stringify(copied)!==JSON.stringify(job.status.artifacts))fail('Media job finalization conflict');return job;
 }
 if(!validMediaJobLease(job,lease,now))fail('Stale media job lease');
 return {...job,status:{...job.status,phase:'succeeded',lease:null,artifacts:copied,error:null},nextDispatchAt:null,completedLease:{...lease}};
}
export function failMediaJob(job:StoredMediaJob,lease:MediaJobLease,error:string,retryable:boolean,now:number):StoredMediaJob {
 if(!validMediaJobLease(job,lease,now))fail('Stale media job lease');
 if(!text(error,4096))fail('Invalid media job failure');
 const retry=retryable&&job.status.attempts<job.status.spec.maxAttempts;
 return {...job,status:{...job.status,phase:retry?'queued':'failed',lease:null,error},nextDispatchAt:retry?now:null};
}

/** Apply a durable ownership fence without constructing future parent input pins. */
export function submitFencedMediaJob(previous:StoredMediaJob|null,spec:MediaJobSpec,now:number,fence:MediaJobWorkflowIdentity|null):StoredMediaJob {
 const snapshot=snapshotMediaJobSpec(spec);
 if(fence&&!sameWorkflow(snapshot.workflow,fence))fail('Media job workflow ownership conflict');
 const job=submitMediaJob(previous,snapshot,now);
 return fence?cancelMediaJob(job):job;
}
export function cancelMediaJobWorkflow(previous:StoredMediaJob|null,owner:MediaJobWorkflowIdentity,fence:MediaJobWorkflowIdentity|null):{job:StoredMediaJob|null;fence:MediaJobWorkflowIdentity}{
 const snapshot=snapshotMediaJobWorkflowIdentity(owner);
 if(fence&&!sameWorkflow(fence,snapshot)||previous&&!sameWorkflow(previous.status.spec.workflow,snapshot))fail('Media job workflow ownership conflict');
 return {job:previous?cancelMediaJob(previous):null,fence:snapshot};
}
