import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
export interface MediaCheckpointLease {readonly generation:number;readonly token:string;readonly expiresAt:number}
export interface CheckpointObject {readonly key:string;readonly etag:string;readonly version:string;readonly size:number;readonly sha256:string}
export interface MediaCheckpointDescriptor {readonly identity:ExecutionCheckpointIdentity;readonly revision:number;readonly inputPosition:string;readonly outputPosition:string;readonly state:CheckpointObject;readonly output:CheckpointObject|null;readonly finished:boolean}
export interface MediaCheckpointStatus {readonly identity:ExecutionCheckpointIdentity;readonly phase:'ready'|'running'|'finished'|'cancelled';readonly revision:number;readonly inputPosition:string;readonly outputPosition:string;readonly lease:MediaCheckpointLease|null;readonly commits:readonly MediaCheckpointDescriptor[]}
export interface MediaCheckpointClaim {readonly lease:MediaCheckpointLease;readonly status:MediaCheckpointStatus}
