import type {R2Bucket,R2Object,R2ObjectBody} from '@cloudflare/workers-types';
import {validateExecutionCheckpoint} from '@edge-ffmpeg/core';
import type {ExecutionCheckpointIdentity} from '@edge-ffmpeg/core';
import type {CheckpointObject,MediaCheckpointDescriptor,MediaCheckpointLease} from './types.js';
import {mediaCheckpointCoordinatorName,mediaCheckpointObjectPrefix,snapshotMediaCheckpointDescriptor} from './state.js';
export interface PrepareMediaCheckpoint {
 readonly revision:number;readonly inputPosition:string;readonly outputPosition:string;
 readonly state:Uint8Array;readonly output:Uint8Array|null;readonly finished:boolean;
}
function limit(bytes:number):void{if(!Number.isSafeInteger(bytes)||bytes<1||bytes>67108864)throw RangeError('Invalid checkpoint object byte limit');}
const sha256=async(bytes:Uint8Array<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
function pointer(object:R2Object,key:string,sha256:string,size:number):CheckpointObject {
 if(typeof object.etag!=='string'||!object.etag||typeof object.version!=='string'||!object.version||object.size!==size)throw Error('Invalid checkpoint object acknowledgement');return {key,etag:object.etag,version:object.version,size,sha256};
}
async function body(object:R2ObjectBody,size:number):Promise<Uint8Array<ArrayBuffer>>{
 const bytes=new Uint8Array(size),reader=object.body.getReader();let offset=0;
 try{for(;;){const next=await reader.read();if(next.done)break;if(next.value.byteLength>size-offset)throw Error('Checkpoint object exceeds declared size');bytes.set(next.value,offset);offset+=next.value.byteLength;}if(offset!==size)throw Error('Truncated checkpoint object');return bytes;}
 finally{try{await reader.cancel();}finally{reader.releaseLock();}}
}
async function write(bucket:R2Bucket,key:string,bytes:Uint8Array<ArrayBuffer>):Promise<CheckpointObject>{
 const hash=await sha256(bytes);let failure:unknown;
 try{const object=await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{edgeCheckpointSha256:hash}});if(object)return pointer(object,key,hash,bytes.length);}catch(error){failure=error;}
 // A lost acknowledgement and an immutable replay use the same content check.
 const existing=await bucket.get(key);if(!existing){if(failure!==undefined)throw failure;throw Error('Checkpoint write could not be confirmed');}
 if(existing.size!==bytes.length||existing.customMetadata?.edgeCheckpointSha256!==hash){await existing.body.cancel();throw Error('Immutable checkpoint object conflict');}
 const stored=await body(existing,bytes.length);if(await sha256(stored)!==hash)throw Error('Immutable checkpoint object digest conflict');return pointer(existing,key,hash,bytes.length);
}
/** Stage immutable attempt objects. Only a successful coordinator commit makes
 * their pointers visible in the logical output stream. No R2 object is deleted
 * after an uncertain response or failed/stale commit.
 */
export async function prepareMediaCheckpoint(bucket:R2Bucket,identity:ExecutionCheckpointIdentity,lease:MediaCheckpointLease,input:PrepareMediaCheckpoint,maxObjectBytes=8388608):Promise<MediaCheckpointDescriptor>{
 limit(maxObjectBytes);const captured=validateExecutionCheckpoint({...identity,version:1,lastCommittedPosition:0n});
 const owner={generation:lease.generation,token:lease.token,expiresAt:lease.expiresAt},revision=input.revision,inputPosition=input.inputPosition,outputPosition=input.outputPosition,finished=input.finished;
 if(!Number.isSafeInteger(owner.generation)||owner.generation<1||typeof owner.token!=='string'||!/^[-_A-Za-z0-9]{1,128}$/.test(owner.token)||!Number.isSafeInteger(owner.expiresAt)||owner.expiresAt<1||!Number.isInteger(revision)||revision<1||revision>256||typeof finished!=='boolean'||[inputPosition,outputPosition].some(value=>typeof value!=='string'||value.length>128||!/^(0|[1-9][0-9]*)$/.test(value)))throw TypeError('Invalid checkpoint preparation');
 if(!(input.state instanceof Uint8Array)||!input.state.length||input.state.length>maxObjectBytes||input.output!==null&&(!(input.output instanceof Uint8Array)||!input.output.length||input.output.length>maxObjectBytes))throw RangeError('Checkpoint payload exceeds object byte limit');
 const state=new Uint8Array(input.state),output=input.output===null?null:new Uint8Array(input.output);
 const prefix=mediaCheckpointObjectPrefix(await mediaCheckpointCoordinatorName(captured),owner,revision);
 const prepared=await Promise.allSettled([write(bucket,prefix+'state.bin',state),output?write(bucket,prefix+'output.bin',output):Promise.resolve(null)]);
 const failures=prepared.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(failures.length)throw new AggregateError(failures,'Checkpoint objects could not be prepared');
 const stateObject=prepared[0]!,outputObject=prepared[1]!;if(stateObject.status!=='fulfilled'||outputObject.status!=='fulfilled'||stateObject.value===null)throw Error('Missing checkpoint preparation');
 return snapshotMediaCheckpointDescriptor({identity:{jobId:captured.jobId,workUnitId:captured.workUnitId,graphHash:captured.graphHash,inputFingerprint:captured.inputFingerprint,implementationVersion:captured.implementationVersion},revision,inputPosition,outputPosition,state:stateObject.value,output:outputObject.value,finished});
}
async function read(bucket:R2Bucket,object:CheckpointObject,maxBytes:number):Promise<Uint8Array<ArrayBuffer>>{
 if(object.size>maxBytes)throw RangeError('Committed checkpoint object exceeds byte limit');
 const stored=await bucket.get(object.key,{onlyIf:{etagMatches:object.etag}});
 if(!stored||!('body' in stored)||!stored.body)throw Error('Committed checkpoint object missing or changed');
 if(stored.version!==object.version||stored.size!==object.size){await stored.body.cancel();throw Error('Committed checkpoint object generation changed');}
 const bytes=await body(stored,object.size);if(await sha256(bytes)!==object.sha256)throw Error('Committed checkpoint object digest mismatch');return bytes;
}
/** Read descriptors obtained from the coordinator's committed journal. Pin and
 * digest validation is not authorization to publish an arbitrary descriptor.
 */
export async function loadMediaCheckpoint(bucket:R2Bucket,descriptor:MediaCheckpointDescriptor,maxObjectBytes=8388608):Promise<{state:Uint8Array;output:Uint8Array|null}>{
 limit(maxObjectBytes);const captured=snapshotMediaCheckpointDescriptor(descriptor);
 // Preflight both sizes before starting provider reads.
 if(captured.state.size>maxObjectBytes||captured.output&&captured.output.size>maxObjectBytes)throw RangeError('Committed checkpoint object exceeds byte limit');
 const results=await Promise.allSettled([read(bucket,captured.state,maxObjectBytes),captured.output?read(bucket,captured.output,maxObjectBytes):Promise.resolve(null)]);
 const failures=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(failures.length)throw new AggregateError(failures,'Committed checkpoint objects could not be loaded');
 const state=results[0]!,output=results[1]!;if(state.status!=='fulfilled'||output.status!=='fulfilled'||state.value===null)throw Error('Missing committed checkpoint state');return {state:state.value,output:output.value};
}
/** Load only the output bytes from a committed descriptor; final assembly does
 * not need to retrieve every historical component state object. */
export async function loadMediaCheckpointOutput(bucket:R2Bucket,descriptor:MediaCheckpointDescriptor,maxObjectBytes=8388608):Promise<Uint8Array|null>{
 limit(maxObjectBytes);const captured=snapshotMediaCheckpointDescriptor(descriptor);return captured.output?read(bucket,captured.output,maxObjectBytes):null;
}
