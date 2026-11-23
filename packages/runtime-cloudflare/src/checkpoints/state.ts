import {validateExecutionCheckpoint} from '@edge-ffmpeg/core';
import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
import type {CheckpointObject,MediaCheckpointClaim,MediaCheckpointDescriptor,MediaCheckpointLease,MediaCheckpointStatus} from './types.js';
export interface StoredMediaCheckpoint {readonly status:MediaCheckpointStatus;readonly namespaceName:string;readonly generation:number;readonly leaseMs:number|null;readonly committers:readonly {readonly generation:number;readonly token:string}[]}
const maxObjectBytes=67108864;
function invalid(message:string):never{throw new Error(message);}
const integer=(value:number,min:number,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
function identity(value:ExecutionCheckpointIdentity):ExecutionCheckpointIdentity {
 const checked=validateExecutionCheckpoint({...value,version:1,lastCommittedPosition:0n});return {jobId:checked.jobId,workUnitId:checked.workUnitId,graphHash:checked.graphHash,inputFingerprint:checked.inputFingerprint,implementationVersion:checked.implementationVersion};
}
export async function mediaCheckpointCoordinatorName(value:ExecutionCheckpointIdentity):Promise<string>{
 const captured=identity(value),bytes=new TextEncoder().encode(JSON.stringify([captured.jobId,captured.workUnitId]));
 return 'checkpoint-'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function mediaCheckpointObjectPrefix(namespaceName:string,lease:MediaCheckpointLease,revision:number):string {
 if(typeof namespaceName!=='string'||!/^checkpoint-[a-f0-9]{64}$/.test(namespaceName)||!integer(lease.generation,1)||typeof lease.token!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(lease.token)||!integer(revision,1,256))invalid('Invalid checkpoint object ownership');
 return `checkpoints/${namespaceName}/${lease.generation}/${lease.token}/revision-${revision}/`;
}
function position(value:string):bigint {if(typeof value!=='string'||value.length>128||!/^(0|[1-9][0-9]*)$/.test(value))invalid('Invalid checkpoint position');return BigInt(value);}
function object(value:CheckpointObject):CheckpointObject {
 if(!value||typeof value.key!=='string'||value.key.length>2048||!value.key.length||value.key.startsWith('/')||/[\\\0]/.test(value.key)||value.key.split('/').some(part=>!part||part==='.'||part==='..')||typeof value.etag!=='string'||!value.etag.length||value.etag.length>256||value.etag.includes('\0')||typeof value.version!=='string'||!value.version.length||value.version.length>256||value.version.includes('\0')||!integer(value.size,1,maxObjectBytes)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))invalid('Invalid checkpoint object');
 return {key:value.key,etag:value.etag,version:value.version,size:value.size,sha256:value.sha256};
}
export function snapshotMediaCheckpointDescriptor(value:MediaCheckpointDescriptor):MediaCheckpointDescriptor {
 if(!value||!integer(value.revision,1,256)||typeof value.finished!=='boolean')invalid('Invalid checkpoint revision or descriptor');position(value.inputPosition);position(value.outputPosition);
 const snapshot={identity:identity(value.identity),revision:value.revision,inputPosition:value.inputPosition,outputPosition:value.outputPosition,state:object(value.state),output:value.output===null?null:object(value.output),finished:value.finished};
 if(new TextEncoder().encode(JSON.stringify(snapshot)).length>8192)invalid('Checkpoint descriptor exceeds bounded metadata');return snapshot;
}
export function initializeMediaCheckpoint(previous:StoredMediaCheckpoint|null,value:ExecutionCheckpointIdentity,namespaceName:string):StoredMediaCheckpoint {
 const captured=identity(value);if(typeof namespaceName!=='string'||!/^checkpoint-[a-f0-9]{64}$/.test(namespaceName))invalid('Invalid checkpoint namespace');
 if(previous){if(JSON.stringify(previous.status.identity)!==JSON.stringify(captured)||previous.namespaceName!==namespaceName)invalid('Checkpoint immutable identity conflict');return previous;}
 return {status:{identity:captured,phase:'ready',revision:0,inputPosition:'0',outputPosition:'0',lease:null,commits:[]},namespaceName,generation:0,leaseMs:null,committers:[]};
}
export function expireMediaCheckpoint(journal:StoredMediaCheckpoint,now:number):StoredMediaCheckpoint {
 const lease=journal.status.lease;if(journal.status.phase!=='running'||lease===null||lease.expiresAt>now)return journal;
 return {...journal,status:{...journal.status,phase:'ready',lease:null},leaseMs:null};
}
export function validMediaCheckpointLease(journal:StoredMediaCheckpoint,lease:MediaCheckpointLease,now:number):boolean {
 const current=journal.status.lease;return journal.status.phase==='running'&&current!==null&&lease!=null&&current.generation===lease.generation&&current.token===lease.token&&current.expiresAt>now;
}
export function claimMediaCheckpoint(previous:StoredMediaCheckpoint,leaseMs:number,now:number,token:string):{journal:StoredMediaCheckpoint;claim:MediaCheckpointClaim|null}{
 if(!integer(leaseMs,10,300000)||typeof token!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(token))invalid('Invalid checkpoint lease');
 const journal=expireMediaCheckpoint(previous,now);if(journal.status.phase!=='ready')return {journal,claim:null};
 const lease={generation:journal.generation+1,token,expiresAt:now+leaseMs};if(!integer(lease.generation,1)||!integer(lease.expiresAt,1))invalid('Checkpoint lease overflow');
 const next={...journal,generation:lease.generation,leaseMs,status:{...journal.status,phase:'running' as const,lease}};return {journal:next,claim:{lease,status:next.status}};
}
export function heartbeatMediaCheckpoint(journal:StoredMediaCheckpoint,lease:MediaCheckpointLease,now:number):{journal:StoredMediaCheckpoint;lease:MediaCheckpointLease|null}{
 if(!validMediaCheckpointLease(journal,lease,now))return {journal:expireMediaCheckpoint(journal,now),lease:null};
 const renewed={...journal.status.lease!,expiresAt:now+journal.leaseMs!};if(!integer(renewed.expiresAt,1))invalid('Checkpoint lease overflow');
 return {journal:{...journal,status:{...journal.status,lease:renewed}},lease:renewed};
}
export function cancelMediaCheckpoint(journal:StoredMediaCheckpoint):StoredMediaCheckpoint {
 if(journal.status.phase==='finished'||journal.status.phase==='cancelled')return journal;return {...journal,status:{...journal.status,phase:'cancelled',lease:null},leaseMs:null};
}
export function commitMediaCheckpoint(journal:StoredMediaCheckpoint,lease:MediaCheckpointLease,value:MediaCheckpointDescriptor,now:number):StoredMediaCheckpoint {
 const descriptor=snapshotMediaCheckpointDescriptor(value),status=journal.status;
 if(JSON.stringify(descriptor.identity)!==JSON.stringify(status.identity))invalid('Checkpoint descriptor identity mismatch');
 if(descriptor.revision<=status.revision){
  const existing=status.commits[descriptor.revision-1],committer=journal.committers[descriptor.revision-1];
  if(existing&&committer?.generation===lease.generation&&committer.token===lease.token&&JSON.stringify(existing)===JSON.stringify(descriptor))return journal;
  invalid('Checkpoint revision conflict or stale committer');
 }
 if(!validMediaCheckpointLease(journal,lease,now))invalid('Stale checkpoint lease');
 if(descriptor.revision!==status.revision+1||status.commits.length>=256)invalid('Checkpoint revision is not the next bounded revision');
 const input=position(descriptor.inputPosition),output=position(descriptor.outputPosition),previousInput=position(status.inputPosition),previousOutput=position(status.outputPosition);
 if(input<previousInput||output<previousOutput||!descriptor.finished&&input===previousInput&&output===previousOutput)invalid('Checkpoint positions must advance monotonically');
 const bytes=output-previousOutput;
 if(bytes===0n?descriptor.output!==null:descriptor.output===null||BigInt(descriptor.output.size)!==bytes)invalid('Checkpoint output pointer does not match committed byte delta');
 const prefix=mediaCheckpointObjectPrefix(journal.namespaceName,lease,descriptor.revision);
 if(descriptor.state.key!==prefix+'state.bin'||descriptor.output!==null&&descriptor.output.key!==prefix+'output.bin')invalid('Checkpoint object is not owned by this lease and revision');
 return {...journal,status:{...status,phase:descriptor.finished?'finished':'running',revision:descriptor.revision,inputPosition:descriptor.inputPosition,outputPosition:descriptor.outputPosition,lease:descriptor.finished?null:status.lease,commits:[...status.commits,descriptor]},leaseMs:descriptor.finished?null:journal.leaseMs,committers:[...journal.committers,{generation:lease.generation,token:lease.token}]};
}
export {identity as snapshotMediaCheckpointIdentity};
