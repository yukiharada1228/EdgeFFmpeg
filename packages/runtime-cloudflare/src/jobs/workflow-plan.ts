import type {MediaJobArtifact,MediaJobInput,MediaJobSpec} from './types.js';
import type {MediaWorkflowInput,MediaWorkflowNode,MediaWorkflowSpec} from './workflow-types.js';
import {snapshotMediaJobSpec} from './state.js';

const encoder=new TextEncoder(),placeholder='0'.repeat(64);
function invalid(message:string):never{throw new TypeError(message);}
const workflowIdentifier=(value:string)=>typeof value==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(value);
const identifier=(value:string,max:number)=>typeof value==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(value);
const canonicalPath=(value:string)=>typeof value==='string'&&value.startsWith('/')&&value.length<=2048&&!/[\\\0]/.test(value)&&value.slice(1).split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
async function hash(value:unknown):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');}

export function mediaWorkflowJobId(workflowId:string,nodeId:string):string {
 if(!workflowIdentifier(workflowId)||!identifier(nodeId,48))invalid('Invalid media workflow identity');
 return `wf-${workflowId.length}-${workflowId}-${nodeId}`;
}
/** Snapshot all command descriptors and verify the complete dependency graph.
 * Nodes retain declared order; dependency resolution is independent of that order.
 */
export function validateMediaWorkflowSpec(spec:MediaWorkflowSpec):MediaWorkflowSpec {
 if(spec.version!==1||!workflowIdentifier(spec.workflowId)||typeof spec.graphHash!=='string'||! /^[a-f0-9]{64}$/.test(spec.graphHash))invalid('Invalid media workflow identity');
 if(spec.sourceGraphHash!==undefined&&(typeof spec.sourceGraphHash!=='string'||! /^[a-f0-9]{64}$/.test(spec.sourceGraphHash)))invalid('Invalid workflow source graph hash');
 if(!Array.isArray(spec.nodes)||spec.nodes.length<1||spec.nodes.length>16)invalid('Invalid media workflow node count');
 if(!Number.isInteger(spec.maxParallel)||spec.maxParallel<1||spec.maxParallel>16||!Number.isInteger(spec.pollIntervalMs)||spec.pollIntervalMs<50||spec.pollIntervalMs>60000||!Number.isInteger(spec.maxPolls)||spec.maxPolls<1||spec.maxPolls>256)invalid('Invalid media workflow scheduling bounds');
 const ids=new Set<string>();
 const nodes:MediaWorkflowNode[]=spec.nodes.map((node:MediaWorkflowNode)=>{
  if(!identifier(node.id,48)||ids.has(node.id))invalid('Invalid or duplicate media workflow node ID');ids.add(node.id);
  if(!Array.isArray(node.inputs))invalid('Invalid media workflow inputs');
  const inputs=node.inputs.map((input:MediaWorkflowInput)=>{
   const source=input.source;
   if(source.kind==='object')return {path:input.path,source:{kind:'object' as const,key:source.key,etag:source.etag,version:source.version,size:source.size}};
   if(source.kind!=='artifact'||!identifier(source.nodeId,48)||!canonicalPath(source.path))invalid('Invalid media workflow artifact reference');
   return {path:input.path,source:{kind:'artifact' as const,nodeId:source.nodeId,path:source.path}};
  });
  const validated=snapshotMediaJobSpec({version:1,jobId:mediaWorkflowJobId(spec.workflowId,node.id),workUnitId:'command',graphHash:placeholder,inputFingerprint:placeholder,implementationVersion:node.implementationVersion,args:node.args,inputs:inputs.map(input=>input.source.kind==='object'?{path:input.path,key:input.source.key,etag:input.source.etag,version:input.source.version,size:input.source.size}:{path:input.path,key:`artifact/${input.source.nodeId}`,etag:'pending',version:'pending',size:0}),outputs:node.outputs,budget:node.budget,maxAttempts:node.maxAttempts,leaseMs:node.leaseMs});
  return {id:node.id,args:validated.args,inputs,outputs:validated.outputs,budget:validated.budget,implementationVersion:validated.implementationVersion,maxAttempts:validated.maxAttempts,leaseMs:validated.leaseMs};
 });
 const byId=new Map(nodes.map(node=>[node.id,node]));
 for(const node of nodes)for(const input of node.inputs)if(input.source.kind==='artifact'){
  const source=input.source,parent=byId.get(source.nodeId);
  if(!parent||!parent.outputs.some(output=>output.path===source.path))invalid('Missing media workflow dependency or artifact output');
 }
 const visiting=new Set<string>(),visited=new Set<string>();
 const visit=(node:MediaWorkflowNode)=>{
  if(visiting.has(node.id))invalid('Cyclic media workflow dependency');if(visited.has(node.id))return;
  visiting.add(node.id);
  for(const input of node.inputs)if(input.source.kind==='artifact')visit(byId.get(input.source.nodeId)!);
  visiting.delete(node.id);visited.add(node.id);
 };
 for(const node of nodes)visit(node);
 const snapshot={version:1 as const,workflowId:spec.workflowId,graphHash:spec.graphHash,...(spec.sourceGraphHash===undefined?{}:{sourceGraphHash:spec.sourceGraphHash}),nodes,maxParallel:spec.maxParallel,pollIntervalMs:spec.pollIntervalMs,maxPolls:spec.maxPolls};
 if(encoder.encode(JSON.stringify(snapshot)).length>262144)invalid('Media workflow specification exceeds bounded payload');
 return snapshot;
}
export async function hashMediaWorkflowSpec(spec:MediaWorkflowSpec):Promise<string>{
 const normalized=validateMediaWorkflowSpec(spec);
 return hash({version:normalized.version,workflowId:normalized.workflowId,...(normalized.sourceGraphHash===undefined?{}:{sourceGraphHash:normalized.sourceGraphHash}),nodes:normalized.nodes,maxParallel:normalized.maxParallel,pollIntervalMs:normalized.pollIntervalMs,maxPolls:normalized.maxPolls});
}
export async function verifyMediaWorkflowSpec(spec:MediaWorkflowSpec):Promise<MediaWorkflowSpec>{
 const snapshot=validateMediaWorkflowSpec(spec);
 if(await hashMediaWorkflowSpec(snapshot)!==snapshot.graphHash)invalid('Media workflow graph hash mismatch');
 return snapshot;
}
export function readyMediaWorkflowNodes(spec:MediaWorkflowSpec,completed:ReadonlySet<string>,running:ReadonlySet<string>):readonly MediaWorkflowNode[]{
 const nodes=spec.nodes,ids=new Set(nodes.map(node=>node.id));
 for(const id of [...completed,...running])if(!ids.has(id))invalid('Unknown media workflow status node');
 for(const id of running)if(completed.has(id))invalid('Media workflow node cannot be running and completed');
 if(running.size>spec.maxParallel)invalid('Media workflow running count exceeds parallel bound');
 return nodes.filter(node=>!completed.has(node.id)&&!running.has(node.id)&&node.inputs.every(input=>input.source.kind==='object'||completed.has(input.source.nodeId))).slice(0,spec.maxParallel-running.size);
}
export async function deriveMediaJobSpec(spec:MediaWorkflowSpec,nodeId:string,completed:ReadonlyMap<string,readonly MediaJobArtifact[]>):Promise<MediaJobSpec>{
 const parentSnapshots=new Map<string,readonly MediaJobArtifact[]>();
 for(const [id,artifacts]of completed){
  if(parentSnapshots.size>=16||!identifier(id,48)||!Array.isArray(artifacts)||artifacts.length>16)invalid('Invalid completed media workflow artifact map');
  parentSnapshots.set(id,artifacts.map(artifact=>({path:artifact.path,key:artifact.key,etag:artifact.etag,version:artifact.version,size:artifact.size})));
 }
 const snapshot=await verifyMediaWorkflowSpec(spec),node=snapshot.nodes.find(node=>node.id===nodeId);
 if(!node)invalid('Unknown media workflow node');
 const inputs:MediaJobInput[]=node.inputs.map((input:MediaWorkflowInput)=>{
  if(input.source.kind==='object')return {path:input.path,key:input.source.key,etag:input.source.etag,version:input.source.version,size:input.source.size};
  const source=input.source,artifacts=parentSnapshots.get(source.nodeId),matches=artifacts?.filter(artifact=>artifact.path===source.path);
  if(matches?.length!==1)invalid('Missing or ambiguous completed media workflow artifact');
  const artifact=matches[0]!;
  const prefix=`jobs/${encodeURIComponent(mediaWorkflowJobId(snapshot.workflowId,source.nodeId))}/`;
  if(!artifact.key.startsWith(prefix))invalid('Media workflow artifact belongs to a different job');
  return {path:input.path,key:artifact.key,etag:artifact.etag,version:artifact.version,size:artifact.size};
 });
 const inputFingerprint=await hash(inputs),graphHash=await hash({workflowGraphHash:snapshot.graphHash,nodeId:node.id,version:1,workUnits:[{id:'command',args:node.args,inputs:inputs.map(input=>input.path),outputs:node.outputs.map(output=>output.path)}],budget:node.budget,implementationVersion:node.implementationVersion});
 return snapshotMediaJobSpec({version:1,jobId:mediaWorkflowJobId(snapshot.workflowId,node.id),workflow:{workflowId:snapshot.workflowId,graphHash:snapshot.graphHash,nodeId:node.id},workUnitId:'command',graphHash,inputFingerprint,implementationVersion:node.implementationVersion,args:node.args,inputs,outputs:node.outputs,budget:node.budget,maxAttempts:node.maxAttempts,leaseMs:node.leaseMs});
}
