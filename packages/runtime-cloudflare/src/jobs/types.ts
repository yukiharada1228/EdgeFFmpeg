import type {ResourceBudget} from '@edge-ffmpeg/core';

export interface MediaJobInput {readonly path:string;readonly key:string;readonly etag:string;readonly version:string;readonly size:number}
export interface MediaJobOutput {readonly path:string}
export interface MediaJobWorkflowIdentity {readonly workflowId:string;readonly graphHash:string;readonly nodeId:string}
/** One whole command. A retry restarts execution; no codec state is checkpointed. */
export interface MediaJobSpec {
 readonly version:1;
 readonly jobId:string;
 readonly workUnitId:'command';
 readonly workflow?:MediaJobWorkflowIdentity;
 readonly graphHash:string;
 readonly inputFingerprint:string;
 readonly implementationVersion:string;
 readonly args:readonly string[];
 readonly inputs:readonly MediaJobInput[];
 readonly outputs:readonly MediaJobOutput[];
 readonly budget:Readonly<ResourceBudget>;
 readonly maxAttempts:number;
 readonly leaseMs:number;
}
export interface MediaJobLease {readonly generation:number;readonly token:string;readonly expiresAt:number}
export interface MediaJobArtifact {readonly path:string;readonly key:string;readonly etag:string;readonly version:string;readonly size:number}
export type MediaJobPhase='queued'|'running'|'succeeded'|'failed'|'cancelled';
export interface MediaJobStatus {
 readonly spec:MediaJobSpec;
 readonly phase:MediaJobPhase;
 readonly generation:number;
 readonly attempts:number;
 readonly lease:MediaJobLease|null;
 readonly artifacts:readonly MediaJobArtifact[];
 readonly error:string|null;
}
export interface MediaJobClaim {readonly spec:MediaJobSpec;readonly lease:MediaJobLease}
export interface MediaJobMessage {readonly jobId:string}
export interface MediaJobCoordinatorClient {
 submit(spec:MediaJobSpec):Promise<MediaJobStatus>;
 claim():Promise<MediaJobClaim|null>;
 heartbeat(lease:MediaJobLease):Promise<MediaJobLease|null>;
 check(lease:MediaJobLease):Promise<boolean>;
 cancel():Promise<MediaJobStatus>;
 succeed(lease:MediaJobLease,artifacts:readonly MediaJobArtifact[]):Promise<MediaJobStatus>;
 fail(lease:MediaJobLease,error:string,options:{readonly retryable:boolean}):Promise<MediaJobStatus>;
 status():Promise<MediaJobStatus|null>;
}
export function mediaJobArtifactPrefix(jobId:string,lease:MediaJobLease):string {
 return `jobs/${encodeURIComponent(jobId)}/${lease.generation}/${lease.token}/`;
}
