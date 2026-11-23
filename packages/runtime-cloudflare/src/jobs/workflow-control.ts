import type {DurableObjectId} from '@cloudflare/workers-types';
import type {MediaJobStatus,MediaJobWorkflowIdentity} from './types.js';
import type {MediaWorkflowSpec} from './workflow-types.js';
import {mediaWorkflowJobId,verifyMediaWorkflowSpec} from './workflow-plan.js';

export interface MediaWorkflowControlOptions {
 readonly workflow:{get(id:string):Promise<{terminate():Promise<void>;status():Promise<{readonly status:string}>}>};
 readonly JOBS:{idFromName(name:string):DurableObjectId;get(id:DurableObjectId):{cancelWorkflowNode(owner:MediaJobWorkflowIdentity):Promise<MediaJobStatus|null>}};
}
export interface MediaWorkflowCancellationDetails {
 readonly workflowId:string;readonly graphHash:string;readonly fencedNodeIds:readonly string[];
 readonly failures:readonly {readonly nodeId:string;readonly message:string}[];
 readonly workflowStatus:string|null;readonly terminationConfirmed:boolean;
}
export interface MediaWorkflowCancellation {
 readonly workflowId:string;readonly graphHash:string;readonly nodeCount:number;
 readonly fencedNodeIds:readonly string[];readonly workflowStatus:'terminated'|'complete'|'errored';
}
/** A retry repeats the idempotent node fences and reconciles termination. */
export class MediaWorkflowCancellationError extends Error {
 constructor(readonly details:MediaWorkflowCancellationDetails){super('Workflow cancellation was not fully confirmed');this.name='MediaWorkflowCancellationError';}
}
const terminal=(status:string):status is MediaWorkflowCancellation['workflowStatus']=>status==='terminated'||status==='complete'||status==='errored';
const message=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,2048);

/** Fence every declared node before terminating orchestration, including nodes
 * whose parent artifacts do not yet exist. A persisted ownership fence prevents
 * late/replayed submissions from resurrecting a cancelled command job.
 * Direct platform terminate() alone does not establish these job fences.
 */
export async function cancelMediaWorkflow(inputSpec:MediaWorkflowSpec,options:MediaWorkflowControlOptions):Promise<MediaWorkflowCancellation>{
 const {workflow,JOBS}=options,spec=await verifyMediaWorkflowSpec(inputSpec);
 const results=await Promise.allSettled(spec.nodes.map(node=>Promise.resolve().then(()=>JOBS.get(JOBS.idFromName(mediaWorkflowJobId(spec.workflowId,node.id))).cancelWorkflowNode({workflowId:spec.workflowId,graphHash:spec.graphHash,nodeId:node.id}))));
 const fencedNodeIds:string[]=[],failures:{nodeId:string;message:string}[]=[];
 for(let index=0;index<results.length;index++){const result=results[index]!;if(result.status==='fulfilled')fencedNodeIds.push(spec.nodes[index]!.id);else failures.push({nodeId:spec.nodes[index]!.id,message:message(result.reason)});}
 // A foreign ownership conflict must never terminate that other instance.
 // The caller must supply the original trusted submitted workflow spec; this
 // helper's service bindings are capabilities, not an authorization boundary.
 if(failures.length)throw new MediaWorkflowCancellationError({workflowId:spec.workflowId,graphHash:spec.graphHash,fencedNodeIds:Object.freeze(fencedNodeIds),failures:Object.freeze(failures),workflowStatus:null,terminationConfirmed:false});
 let workflowStatus:string|null=null,terminationConfirmed=false;
 try{
  const instance=await workflow.get(spec.workflowId);
  try{await instance.terminate();workflowStatus='terminated';terminationConfirmed=true;}
  catch(error){try{workflowStatus=(await instance.status()).status.slice(0,128);terminationConfirmed=terminal(workflowStatus);if(!terminationConfirmed)failures.push({nodeId:'$workflow',message:message(error)});}catch{failures.push({nodeId:'$workflow',message:message(error)});}}
 }catch(error){failures.push({nodeId:'$workflow',message:message(error)});}
 if(failures.length||!terminationConfirmed||workflowStatus===null||!terminal(workflowStatus))throw new MediaWorkflowCancellationError({workflowId:spec.workflowId,graphHash:spec.graphHash,fencedNodeIds:Object.freeze(fencedNodeIds),failures:Object.freeze(failures),workflowStatus,terminationConfirmed});
 return Object.freeze({workflowId:spec.workflowId,graphHash:spec.graphHash,nodeCount:spec.nodes.length,fencedNodeIds:Object.freeze(fencedNodeIds),workflowStatus});
}
