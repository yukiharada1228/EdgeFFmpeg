import type {R2Bucket} from '@cloudflare/workers-types';
import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
import {snapshotMediaCheckpointIdentity} from './state.js';

/** Bounded JSON passed to the registered component; media code itself never travels in params. */
export type MediaCheckpointWorkflowConfig=null|boolean|number|string|readonly MediaCheckpointWorkflowConfig[]|{readonly [key:string]:MediaCheckpointWorkflowConfig};
/** One pinned R2 input generation; components must read through these pins. */
export interface MediaCheckpointWorkflowInput {readonly key:string;readonly etag:string;readonly version:string;readonly size:number}
export interface MediaCheckpointWorkflowOutput {readonly path:string;readonly overwrite:boolean;readonly maxWriteBytes:number;readonly maxReadBytes:number}
export interface MediaCheckpointWorkflowPolicy {
 /** Runner lease and per-invocation unit budget (`maxUnits`). */
 readonly leaseMs:number;readonly unitsPerInvocation:number;readonly maxObjectBytes:number;readonly maxCommitAttempts:number;
 /** Durable unit steps plus busy sleeps (so an instance has at most `maxInvocations + 2` steps); transient
  * step retries; first retry delay (exponential). */
 readonly maxInvocations:number;readonly maxRetries:number;readonly retryDelayMs:number;
 /** Margin after a foreign lease's reported expiry before claiming again; timeout of one unit step attempt,
  * at least `(unitsPerInvocation + 2) * leaseMs + 1000`. */
 readonly pollIntervalMs:number;readonly stepTimeoutMs:number;
}
/** Workflow params. `identity.graphHash` binds component+config, `identity.inputFingerprint` binds the
 * pins and `specHash` binds everything else; the checkpoint journal is keyed by job/WorkUnit identity. */
export interface MediaCheckpointWorkflowSpec {
 readonly version:1;readonly workflowId:string;readonly specHash:string;
 readonly identity:ExecutionCheckpointIdentity;
 readonly component:string;readonly config:MediaCheckpointWorkflowConfig;
 readonly inputs:readonly MediaCheckpointWorkflowInput[];
 readonly output:MediaCheckpointWorkflowOutput;
 readonly policy:MediaCheckpointWorkflowPolicy;
}
export interface BuildMediaCheckpointWorkflowOptions {
 readonly bucket:Pick<R2Bucket,'head'>;
 readonly workflowId:string;readonly jobId:string;readonly workUnitId:string;
 /** Registry name; the registered implementation version must equal `implementationVersion`. */
 readonly component:string;readonly config?:MediaCheckpointWorkflowConfig;
 /** Must change when the component code, codec artifact or arithmetic profile changes. */
 readonly implementationVersion:string;
 readonly inputs:readonly {readonly key:string}[];
 readonly output:{readonly path:string;readonly overwrite?:boolean;readonly maxWriteBytes?:number;readonly maxReadBytes?:number};
 readonly policy?:Partial<MediaCheckpointWorkflowPolicy>;
}
export const mediaCheckpointWorkflowDefaults:MediaCheckpointWorkflowPolicy=Object.freeze({leaseMs:30000,unitsPerInvocation:8,maxObjectBytes:8388608,maxCommitAttempts:3,maxInvocations:512,maxRetries:3,retryDelayMs:1000,pollIntervalMs:1000,stepTimeoutMs:600000});
/** Guard between a unit step's own deadline (`stepTimeoutMs - leaseMs - guard`) and the platform step timeout. */
export const mediaCheckpointWorkflowStepGuardMs=1000;
const encoder=new TextEncoder(),placeholder='0'.repeat(64),maxSpecBytes=65536,maxConfigBytes=16384;
function invalid(message:string):never{throw new TypeError(message);}
const integer=(value:unknown,min:number,max:number)=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0');
const workflowIdentifier=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(value);
const componentName=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_][-_.A-Za-z0-9]{0,63}$/.test(value);
const canonicalPath=(value:unknown)=>typeof value==='string'&&value.startsWith('/')&&value.length<=2048&&!/[\\\0]/.test(value)&&value.slice(1).split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
const objectKey=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=2048&&!value.startsWith('/')&&!/[\\\0]/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
async function hash(value:unknown):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');}
/** Canonical copy: sorted keys, finite numbers, bounded depth/width; key order never changes identity. */
function config(value:unknown,depth:number):MediaCheckpointWorkflowConfig {
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='string'){if(value.length>4096)invalid('Checkpoint workflow configuration string is too long');return value;}
 if(typeof value==='number'){if(!Number.isFinite(value))invalid('Checkpoint workflow configuration number is not finite');return Object.is(value,-0)?0:value;}
 if(depth>=8)invalid('Checkpoint workflow configuration is too deep');
 if(Array.isArray(value)){if(value.length>256)invalid('Checkpoint workflow configuration array is too long');return Array.from(value,item=>config(item,depth+1));}
 const prototype=typeof value==='object'?Object.getPrototypeOf(value):undefined;if(prototype!==Object.prototype&&prototype!==null)invalid('Invalid checkpoint workflow configuration');
 const record=value as Record<string,unknown>,keys=Object.keys(record).sort();
 if(keys.length>64||keys.some(key=>!/^[A-Za-z0-9_][-_.A-Za-z0-9]{0,63}$/.test(key)))invalid('Invalid checkpoint workflow configuration keys');
 return Object.fromEntries(keys.map(key=>[key,config(record[key],depth+1)]));
}
function policy(value:MediaCheckpointWorkflowPolicy):MediaCheckpointWorkflowPolicy {
 if(!value||typeof value!=='object')invalid('Invalid checkpoint workflow policy');
 const {leaseMs,unitsPerInvocation,maxObjectBytes,maxCommitAttempts,maxInvocations,maxRetries,retryDelayMs,pollIntervalMs,stepTimeoutMs}=value;
 if(!integer(leaseMs,10,300000)||!integer(unitsPerInvocation,1,256)||!integer(maxObjectBytes,1,67108864)||!integer(maxCommitAttempts,1,8)||!integer(maxInvocations,1,512)||!integer(maxRetries,0,10)||!integer(retryDelayMs,10,300000)||!integer(pollIntervalMs,10,300000)||!integer(stepTimeoutMs,1000,1800000))invalid('Invalid checkpoint workflow policy bounds');
 // Claim/restore and every unit each fit one lease, so a full invocation ends before the step's own deadline
 // (one lease plus the guard before the platform timeout); the deadline only stops an overrunning attempt.
 if((unitsPerInvocation+2)*leaseMs+mediaCheckpointWorkflowStepGuardMs>stepTimeoutMs)invalid('Checkpoint workflow step timeout does not cover unitsPerInvocation + 2 leases');
 return {leaseMs,unitsPerInvocation,maxObjectBytes,maxCommitAttempts,maxInvocations,maxRetries,retryDelayMs,pollIntervalMs,stepTimeoutMs};
}
/** Snapshot and bound every field before any hash or provider call. Hashes are checked by `verify`. */
export function validateMediaCheckpointWorkflowSpec(spec:MediaCheckpointWorkflowSpec):MediaCheckpointWorkflowSpec {
 if(!spec||spec.version!==1||!workflowIdentifier(spec.workflowId)||typeof spec.specHash!=='string'||!/^[a-f0-9]{64}$/.test(spec.specHash))invalid('Invalid checkpoint workflow identity');
 const identity=snapshotMediaCheckpointIdentity(spec.identity);
 if(!componentName(spec.component))invalid('Invalid checkpoint workflow component name');
 const captured=config(spec.config,0);if(encoder.encode(JSON.stringify(captured)).length>maxConfigBytes)invalid('Checkpoint workflow configuration exceeds bounded payload');
 if(!Array.isArray(spec.inputs)||spec.inputs.length<1||spec.inputs.length>16)invalid('Invalid checkpoint workflow input count');
 const keys=new Set<string>(),inputs=spec.inputs.map((input:MediaCheckpointWorkflowInput)=>{
  if(!input||!objectKey(input.key)||keys.has(input.key)||!text(input.etag,256)||!text(input.version,256)||!integer(input.size,0,Number.MAX_SAFE_INTEGER))invalid('Invalid or duplicate checkpoint workflow input pin');
  keys.add(input.key);return {key:input.key,etag:input.etag,version:input.version,size:input.size};
 });
 const limits=policy(spec.policy),output=spec.output;
 if(!output||!canonicalPath(output.path)||typeof output.overwrite!=='boolean')invalid('Invalid checkpoint workflow output destination');
 if(!integer(output.maxWriteBytes,1,limits.maxObjectBytes)||!integer(output.maxReadBytes,1,limits.maxObjectBytes))invalid('Invalid checkpoint workflow output byte limits');
 const snapshot={version:1 as const,workflowId:spec.workflowId,specHash:spec.specHash,identity,component:spec.component,config:captured,inputs,output:{path:output.path,overwrite:output.overwrite,maxWriteBytes:output.maxWriteBytes,maxReadBytes:output.maxReadBytes},policy:limits};
 if(encoder.encode(JSON.stringify(snapshot)).length>maxSpecBytes)invalid('Checkpoint workflow specification exceeds bounded payload');
 return snapshot;
}
/** The identity `graphHash` of a registered component name and its canonical configuration. */
export async function mediaCheckpointWorkflowGraphHash(component:string,value:MediaCheckpointWorkflowConfig):Promise<string>{
 if(!componentName(component))invalid('Invalid checkpoint workflow component name');return hash({version:1,component,config:config(value,0)});
}
const fingerprint=(inputs:readonly MediaCheckpointWorkflowInput[])=>hash({version:1,inputs:inputs.map(input=>({key:input.key,etag:input.etag,version:input.version,size:input.size}))});
export async function hashMediaCheckpointWorkflowSpec(spec:MediaCheckpointWorkflowSpec):Promise<string>{
 const value=validateMediaCheckpointWorkflowSpec(spec);
 return hash({version:value.version,workflowId:value.workflowId,identity:value.identity,component:value.component,config:value.config,inputs:value.inputs,output:value.output,policy:value.policy});
}
/** Recompute graph hash, input fingerprint and spec hash; any mismatch is a deterministic rejection. */
export async function verifyMediaCheckpointWorkflowSpec(spec:MediaCheckpointWorkflowSpec):Promise<MediaCheckpointWorkflowSpec>{
 const snapshot=validateMediaCheckpointWorkflowSpec(spec);
 if(await mediaCheckpointWorkflowGraphHash(snapshot.component,snapshot.config)!==snapshot.identity.graphHash||await fingerprint(snapshot.inputs)!==snapshot.identity.inputFingerprint)invalid('Checkpoint workflow identity does not bind its component or inputs');
 if(await hashMediaCheckpointWorkflowSpec(snapshot)!==snapshot.specHash)invalid('Checkpoint workflow specification hash mismatch');
 return snapshot;
}
function freeze<T>(value:T):T {
 if(value!==null&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))freeze(item);}
 return value;
}
/** Validate everything, then pin each input generation once with `head` and derive the immutable identity. */
export async function buildMediaCheckpointWorkflowSpec(options:BuildMediaCheckpointWorkflowOptions):Promise<MediaCheckpointWorkflowSpec>{
 const head=options.bucket.head.bind(options.bucket),output=options.output,limits={...mediaCheckpointWorkflowDefaults,...options.policy};
 if(!Array.isArray(options.inputs))invalid('Invalid checkpoint workflow input count');
 const maxWriteBytes=output?.maxWriteBytes??Math.min(65536,limits.maxObjectBytes);
 // Full validation and snapshot happen before the first provider await.
 const draft=validateMediaCheckpointWorkflowSpec({version:1,workflowId:options.workflowId,specHash:placeholder,identity:{jobId:options.jobId,workUnitId:options.workUnitId,graphHash:placeholder,inputFingerprint:placeholder,implementationVersion:options.implementationVersion},component:options.component,config:options.config??null,inputs:options.inputs.map(input=>({key:input?.key,etag:'pending',version:'pending',size:0})),output:{path:output?.path,overwrite:output?.overwrite??false,maxWriteBytes,maxReadBytes:output?.maxReadBytes??maxWriteBytes},policy:limits});
 const inputs=await Promise.all(draft.inputs.map(async input=>{
  const object=await head(input.key);
  if(!object||!Number.isSafeInteger(object.size)||object.size<0||!object.etag||!object.version)throw new Error('Invalid or missing checkpoint workflow input: '+input.key);
  return {key:input.key,etag:object.etag,version:object.version,size:object.size};
 }));
 const identity={...draft.identity,graphHash:await mediaCheckpointWorkflowGraphHash(draft.component,draft.config),inputFingerprint:await fingerprint(inputs)};
 const pinned=validateMediaCheckpointWorkflowSpec({...draft,identity,inputs});
 return freeze({...pinned,specHash:await hashMediaCheckpointWorkflowSpec(pinned)});
}
