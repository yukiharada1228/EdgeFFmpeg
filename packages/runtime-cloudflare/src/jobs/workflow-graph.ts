import type {R2Bucket} from '@cloudflare/workers-types';
import {planIndependentGraph} from '@edge-ffmpeg/core';
import type {ExecutionGraph,FeatureRegistry,IndependentGraphPlan,IndependentGraphWorkUnit,OperatorDescriptor,ResourceBudget} from '@edge-ffmpeg/core';
import {buildMediaWorkflowSpec} from './workflow-spec.js';
import type {BuildMediaWorkflowNode} from './workflow-spec.js';
import type {MediaWorkflowSpec} from './workflow-types.js';

export type IndependentMediaCommand=Omit<BuildMediaWorkflowNode,'id'|'budget'|'inputs'>&{
 readonly inputs:readonly {readonly path:string;readonly source:{readonly kind:'object';readonly key:string}}[];
};
export interface BuildIndependentMediaWorkflowOptions {
 readonly bucket:Pick<R2Bucket,'head'>;
 readonly workflowId:string;
 readonly graph:ExecutionGraph;
 readonly registry:FeatureRegistry<OperatorDescriptor>;
 readonly budget:Readonly<ResourceBudget>;
 /** Application lowering for each complete independent component. The library
  * does not infer FFmpeg command arguments from arbitrary operator metadata. */
 readonly commandForWorkUnit:(unit:IndependentGraphWorkUnit)=>IndependentMediaCommand;
 readonly maxParallel?:number;
 readonly pollIntervalMs?:number;
 readonly maxPolls?:number;
}
export interface IndependentMediaWorkflow {
 readonly plan:IndependentGraphPlan;
 readonly spec:MediaWorkflowSpec;
 readonly workUnits:readonly {readonly workUnitId:string;readonly nodeId:string}[];
}
/** Automatically separate independent graph components, validate each against
 * one Worker budget, and lower complete components into command jobs. Connected
 * media paths stay together; no temporal cuts or codec serialization is implied.
 */
export async function buildIndependentMediaWorkflowSpec(options:BuildIndependentMediaWorkflowOptions):Promise<IndependentMediaWorkflow>{
 const {workflowId,maxParallel,pollIntervalMs,maxPolls,commandForWorkUnit}=options,bucket={head:options.bucket.head.bind(options.bucket)};
 const budget={...options.budget},plan=planIndependentGraph(options.graph,options.registry,'cloudflare',budget);
 if(plan.workUnits.length>16)throw RangeError('Independent workflow exceeds 16 command jobs');
 const mappings=plan.workUnits.map((unit,index)=>Object.freeze({workUnitId:unit.id,nodeId:`unit-${index}`}));
 const nodes=plan.workUnits.map((unit,index):BuildMediaWorkflowNode=>{
  const command=commandForWorkUnit(unit);
  // Keep the component topology independent even for untyped callers.
  if(!Array.isArray(command.inputs)||command.inputs.some(input=>input.source.kind!=='object'))throw TypeError('Independent work units require external object inputs');
  return {...command,id:mappings[index]!.nodeId,budget:{...budget}};
 });
 const capturedNodes=structuredClone(nodes);
 const sourceGraphHash=await hashPlan(plan,budget);
 const spec=await buildMediaWorkflowSpec({bucket,workflowId,sourceGraphHash,nodes:capturedNodes,...(maxParallel===undefined?{}:{maxParallel}),...(pollIntervalMs===undefined?{}:{pollIntervalMs}),...(maxPolls===undefined?{}:{maxPolls})});
 return Object.freeze({plan,spec,workUnits:Object.freeze(mappings)});
}

async function hashPlan(plan:IndependentGraphPlan,budget:ResourceBudget):Promise<string>{
 const descriptor={version:1,budget:{maxResidentBytes:budget.maxResidentBytes,maxBufferBytes:budget.maxBufferBytes,maxCpuTimeMs:budget.maxCpuTimeMs,maxPendingPackets:budget.maxPendingPackets},workUnits:plan.workUnits.map(unit=>({id:unit.id,nodeIds:unit.nodeIds,nodes:unit.graph.nodes.map(node=>{const op=node.operator,t=op.traits;return {id:node.id,featureId:node.featureId,operator:{id:op.id,kind:op.kind,status:op.status,runtimes:[...op.runtimes].sort(),testCases:[...op.testCases].sort(),reason:op.reason??null,inputs:op.inputs.map(port=>({name:port.name,type:port.type,optional:port.optional??false})),outputs:op.outputs.map(port=>({name:port.name,type:port.type,optional:port.optional??false})),traits:{state:t.state,access:t.access,checkpointable:t.checkpointable,temporal:t.temporal,deterministic:t.deterministic,minimumMemoryBytes:t.minimumMemoryBytes,estimatedCpuTimeMs:t.estimatedCpuTimeMs}}};}),edges:unit.graph.edges.map(edge=>({from:{node:edge.from.node,port:edge.from.port},to:{node:edge.to.node,port:edge.to.port},queueCapacity:edge.queueCapacity}))}))};
 const bytes=new TextEncoder().encode(JSON.stringify(descriptor));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
