export interface ExecutionCheckpointIdentity {
 readonly jobId:string;
 readonly workUnitId:string;
 readonly graphHash:string;
 readonly inputFingerprint:string;
 readonly implementationVersion:string;
}
/** Component state is only supported by components with an explicit state codec.
 * A checkpoint position records the caller's committed boundary, not an atomic
 * transaction with media output or a serialized generic execution context. */
export interface ExecutionCheckpoint extends ExecutionCheckpointIdentity {
 readonly version:1;
 readonly lastCommittedPosition:bigint;
 readonly codecStateRef?:string;
 readonly filterStateRef?:string;
 readonly muxerStateRef?:string;
}
export class CheckpointCompatibilityError extends Error {}
const invalid=(message:string):never=>{throw new CheckpointCompatibilityError(message);};
const identityKeys=['jobId','workUnitId','graphHash','inputFingerprint','implementationVersion'] as const;
const referenceKeys=['codecStateRef','filterStateRef','muxerStateRef'] as const;
function identity(value:ExecutionCheckpointIdentity):ExecutionCheckpointIdentity{
 if(!value||typeof value.jobId!=='string'||!/^[-_A-Za-z0-9]{1,128}$/.test(value.jobId)||typeof value.workUnitId!=='string'||!value.workUnitId.length||value.workUnitId.length>4096||value.workUnitId.includes('\0')||![value.graphHash,value.inputFingerprint].every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash))||typeof value.implementationVersion!=='string'||!value.implementationVersion.length||value.implementationVersion.length>256||value.implementationVersion.includes('\0'))invalid('Invalid checkpoint identity');
 return {jobId:value.jobId,workUnitId:value.workUnitId,graphHash:value.graphHash,inputFingerprint:value.inputFingerprint,implementationVersion:value.implementationVersion};
}
function bound(maxBytes:number):void{if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>65536)invalid('Invalid checkpoint byte limit');}
export function validateExecutionCheckpoint(value:ExecutionCheckpoint,expected?:ExecutionCheckpointIdentity):ExecutionCheckpoint{
 const captured=identity(value);
 if(value.version!==1||typeof value.lastCommittedPosition!=='bigint'||value.lastCommittedPosition<0n||value.lastCommittedPosition.toString().length>4096)invalid('Unsupported checkpoint version or position');
 if(expected){const wanted=identity(expected);if(identityKeys.some(key=>captured[key]!==wanted[key]))invalid('Checkpoint identity or implementation mismatch');}
 const refs:Partial<Pick<ExecutionCheckpoint,typeof referenceKeys[number]>>={};
 for(const key of referenceKeys){const ref=value[key];if(ref===undefined)continue;if(typeof ref!=='string'||!ref.length||ref.length>2048||ref.startsWith('/')||/[\\\0]/.test(ref)||ref.split('/').some(part=>!part||part==='.'||part==='..'))invalid('Invalid checkpoint state reference');Object.assign(refs,{[key]:ref});}
 return Object.freeze({version:1,...captured,...refs,lastCommittedPosition:value.lastCommittedPosition});
}
export function serializeExecutionCheckpoint(value:ExecutionCheckpoint,maxBytes=16384):Uint8Array{
 bound(maxBytes);const snapshot=validateExecutionCheckpoint(value),bytes=new TextEncoder().encode(JSON.stringify({...snapshot,lastCommittedPosition:snapshot.lastCommittedPosition.toString()}));if(bytes.length>maxBytes)invalid('Checkpoint byte limit exceeded');return bytes;
}
export function deserializeExecutionCheckpoint(bytes:Uint8Array,expected:ExecutionCheckpointIdentity,maxBytes=16384):ExecutionCheckpoint{
 bound(maxBytes);const wanted=identity(expected);if(!(bytes instanceof Uint8Array)||bytes.byteLength>maxBytes)invalid('Checkpoint byte limit exceeded');
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{invalid('Invalid checkpoint encoding');}
 if(!value||typeof value!=='object'||Array.isArray(value))invalid('Invalid checkpoint record');
 const record=value as Record<string,unknown>,allowed=new Set<string>(['version',...identityKeys,...referenceKeys,'lastCommittedPosition']);
 if(Object.keys(record).some(key=>!allowed.has(key))||typeof record.lastCommittedPosition!=='string'||record.lastCommittedPosition.length>4096||!/^(0|[1-9][0-9]*)$/.test(record.lastCommittedPosition))invalid('Invalid checkpoint position or fields');
 return validateExecutionCheckpoint({...record,lastCommittedPosition:BigInt(record.lastCommittedPosition as string)} as unknown as ExecutionCheckpoint,wanted);
}
