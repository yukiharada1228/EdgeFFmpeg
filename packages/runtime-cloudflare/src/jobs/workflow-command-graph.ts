import {lowerIndependentCommand,lowerComplexVideoCommand} from '@edge-ffmpeg/core';
import type {CommandOperatorBinding} from '@edge-ffmpeg/core';
import {buildIndependentMediaWorkflowSpec} from './workflow-graph.js';
import type {BuildIndependentMediaWorkflowOptions,IndependentMediaWorkflow} from './workflow-graph.js';

export interface BuildCommandGraphMediaWorkflowOptions extends Omit<BuildIndependentMediaWorkflowOptions,'commandForWorkUnit'> {
 readonly bindings:ReadonlyMap<string,CommandOperatorBinding>;
 readonly implementationVersion:string;
 readonly globalArgs?:readonly string[];
 readonly maxAttempts?:number;
 readonly leaseMs?:number;
}
/** Lower supported linear operator components without an application command
 * callback. Branches, joins and unsupported operator bindings fail before R2 I/O.
 */
export async function buildCommandGraphMediaWorkflowSpec(options:BuildCommandGraphMediaWorkflowOptions):Promise<IndependentMediaWorkflow>{
 return buildBoundGraphWorkflow(options,lowerIndependentCommand);
}

/** Lower explicit video filter DAGs, including split/join nodes, as complete jobs. */
export async function buildComplexVideoGraphMediaWorkflowSpec(options:BuildCommandGraphMediaWorkflowOptions):Promise<IndependentMediaWorkflow>{
 return buildBoundGraphWorkflow(options,lowerComplexVideoCommand);
}

async function buildBoundGraphWorkflow(options:BuildCommandGraphMediaWorkflowOptions,lower:typeof lowerIndependentCommand):Promise<IndependentMediaWorkflow>{
 const bindings=new Map([...options.bindings].map(([id,value])=>[id,structuredClone(value)])),globalArgs=options.globalArgs?[...options.globalArgs]:[];
 const {implementationVersion,maxAttempts,leaseMs}=options;
 const ids=new Set(options.graph.nodes.map(node=>node.id));
 if(bindings.size!==ids.size||[...bindings.keys()].some(id=>!ids.has(id)))throw TypeError('Command graph requires exactly one binding per node');
 return buildIndependentMediaWorkflowSpec({...options,commandForWorkUnit:unit=>{
  const command=lower(unit,new Map(unit.nodeIds.map(id=>[id,bindings.get(id)!])),{globalArgs});
  return {args:command.args,inputs:command.inputs.map(input=>({path:input.path,source:{kind:'object' as const,key:input.key}})),outputs:command.outputs,implementationVersion,...(maxAttempts===undefined?{}:{maxAttempts}),...(leaseMs===undefined?{}:{leaseMs})};
 }});
}
