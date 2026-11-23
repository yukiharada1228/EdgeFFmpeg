import type {R2Bucket,R2ObjectBody} from '@cloudflare/workers-types';
import type {MediaWorkflowResult,MediaWorkflowSpec} from './workflow-types.js';
import type {MediaJobStatus} from './types.js';
import {mediaWorkflowJobId,validateMediaWorkflowSpec,verifyMediaWorkflowSpec} from './workflow-plan.js';

export interface MediaWorkflowManifest {
 readonly workflowId:string;readonly graphHash:string;readonly key:string;
 readonly etag:string;readonly version:string;readonly size:number;
 readonly sha256:string;readonly jobCount:number;
}
const maxManifestBytes=524288;
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const hash=async(bytes:Uint8Array<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
function manifestBytes(result:MediaWorkflowResult):Uint8Array<ArrayBuffer>{
 if(!/^[-_A-Za-z0-9]{1,128}$/.test(result.workflowId)||!/^[a-f0-9]{64}$/.test(result.graphHash))throw Error('Invalid workflow result identity');
 const entries=Object.entries(result.artifacts).sort(([a],[b])=>compare(a,b));if(entries.length<1||entries.length>64)throw Error('Invalid workflow result node count');
 const artifacts:Record<string,unknown>=Object.create(null);
 for(const [nodeId,values]of entries){
  if(!/^[-_A-Za-z0-9]{1,64}$/.test(nodeId)||!Array.isArray(values)||values.length<1||values.length>16)throw Error('Invalid workflow result artifacts');
  const paths=new Set<string>();artifacts[nodeId]=[...values].sort((a,b)=>compare(a.path,b.path)).map(value=>{
   if(![value.path,value.key,value.etag,value.version].every(text=>typeof text==='string'&&text.length>0&&text.length<=4096)||paths.has(value.path)||!Number.isSafeInteger(value.size)||value.size<0)throw Error('Invalid workflow result artifact');paths.add(value.path);
   return {path:value.path,key:value.key,etag:value.etag,version:value.version,size:value.size};
  });
 }
 const bytes=new TextEncoder().encode(JSON.stringify({version:1,workflowId:result.workflowId,graphHash:result.graphHash,artifacts}));if(bytes.length>maxManifestBytes)throw RangeError('Workflow manifest byte limit exceeded');return new Uint8Array(bytes);
}
async function sameBody(object:R2ObjectBody,expected:Uint8Array):Promise<boolean>{
 const reader=object.body.getReader();let offset=0;
 try{for(;;){const part=await reader.read();if(part.done)return offset===expected.length;if(part.value.length>expected.length-offset)return false;for(let index=0;index<part.value.length;index++)if(part.value[index]!==expected[offset+index])return false;offset+=part.value.length;}}
 finally{try{await reader.cancel();}finally{reader.releaseLock();}}
}

/** Conditional immutable publication. A retry verifies the exact canonical
 * bytes and metadata, including after an R2 write acknowledgement is lost.
 */
export async function publishMediaWorkflowResult(bucket:R2Bucket,inputSpec:MediaWorkflowSpec,statuses:ReadonlyMap<string,Pick<MediaJobStatus,'phase'|'artifacts'>>):Promise<MediaWorkflowManifest>{
 const normalized=validateMediaWorkflowSpec(inputSpec);
 if(statuses.size!==normalized.nodes.length)throw Error('Workflow result requires every node');
 const captured=new Map([...statuses].map(([id,status])=>{if(!Array.isArray(status.artifacts)||status.artifacts.length>16)throw Error('Invalid workflow result artifacts');return [id,{phase:status.phase,artifacts:status.artifacts.map(artifact=>({...artifact}))}] as const;}));
 const spec=await verifyMediaWorkflowSpec(normalized);
 const artifacts:MediaWorkflowResult['artifacts']=Object.create(null);
 const mutable:Record<string,MediaJobStatus['artifacts']>=artifacts;
 for(const node of spec.nodes){const status=captured.get(node.id);if(status?.phase!=='succeeded')throw Error('Workflow result requires successful nodes');
  const paths=new Set(node.outputs.map(output=>output.path)),prefix=`jobs/${mediaWorkflowJobId(spec.workflowId,node.id)}/`;
  if(status.artifacts.length!==paths.size||status.artifacts.some(artifact=>!paths.delete(artifact.path)||!artifact.key.startsWith(prefix)))throw Error('Workflow result does not match declared outputs');
  mutable[node.id]=status.artifacts;
 }
 const result:MediaWorkflowResult={workflowId:spec.workflowId,graphHash:spec.graphHash,artifacts};
 const bytes=manifestBytes(result),sha256=await hash(bytes),key=`workflows/${result.workflowId}/${result.graphHash}.json`,jobCount=Object.keys(result.artifacts).length;
 const metadata={edgeWorkflowId:result.workflowId,edgeWorkflowGraphHash:result.graphHash,edgeWorkflowResultSha256:sha256};
 let writeError:unknown;
 try{const object=await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},customMetadata:metadata,httpMetadata:{contentType:'application/json'}});if(object)return {...metadataPointer(object),workflowId:result.workflowId,graphHash:result.graphHash,key,sha256,jobCount};}
 catch(error){writeError=error;}
 const object=await bucket.get(key);
 if(!object){if(writeError!==undefined)throw writeError;throw Error('Workflow result publication could not be confirmed');}
 const validMetadata=object.size===bytes.length&&Object.entries(metadata).every(([name,value])=>object.customMetadata?.[name]===value);
 if(!validMetadata){await object.body.cancel();throw Error('Immutable workflow result conflict');}
 if(!await sameBody(object,bytes))throw Error('Immutable workflow result byte conflict');
 return {...metadataPointer(object),workflowId:result.workflowId,graphHash:result.graphHash,key,sha256,jobCount};
}
function metadataPointer(object:{etag:string;version:string;size:number}):{etag:string;version:string;size:number}{
 if(!object.etag||!object.version||!Number.isSafeInteger(object.size)||object.size<0||object.size>maxManifestBytes)throw Error('Invalid workflow manifest object metadata');return {etag:object.etag,version:object.version,size:object.size};
}
