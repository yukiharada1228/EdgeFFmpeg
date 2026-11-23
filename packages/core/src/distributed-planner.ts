import type {ResourceBudget} from './index.js';
import type {FeatureRegistry} from './registry.js';
import {planGraph,PlanningError} from './planner.js';
import type {ExecutionGraph,GraphEdge,GraphNode,OperatorDescriptor,PlannedGraph} from './planner.js';

export interface IndependentGraphWorkUnit {
 /** Injective canonical membership ID; not a remote runtime job identifier. */
 readonly id:string;
 readonly nodeIds:readonly string[];
 readonly graph:PlannedGraph;
 readonly dependencies:readonly string[];
 readonly minimumMemoryBytes:number;
 readonly reservedPacketSlots:number;
 readonly estimatedCpuTimeMs:number|null;
 readonly traits:Readonly<OperatorDescriptor['traits']>;
}
export interface IndependentGraphPlan {
 readonly workUnits:readonly IndependentGraphWorkUnit[];
 /** Totals across workers, not a single-worker admission budget. */
 readonly aggregate:{readonly minimumMemoryBytes:number;readonly reservedPacketSlots:number;readonly estimatedCpuTimeMs:number|null};
 readonly warnings:readonly string[];
}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
function add(a:number,b:number,label:string):number {
 const total=a+b;
 if(!Number.isSafeInteger(total))throw new PlanningError('resource-budget',`${label} exceeds safe integer range`);
 return total;
}
function cpu(nodes:PlannedGraph['nodes']):number|null {
 let known=0,unknown=false;
 for(const node of nodes){const estimate=node.operator.traits.estimatedCpuTimeMs;if(estimate===null)unknown=true;else known=add(known,estimate,'CPU estimate');}
 return unknown?null:known;
}
/** Automatically separate only already disconnected media graphs. Every weakly
 * connected component stays intact, including stateful/temporal paths and their
 * queues. This returns planning metadata; it neither runs distributed operators
 * nor establishes Native compatibility or codec checkpoint boundaries.
 */
export function planIndependentGraph(graph:ExecutionGraph,registry:FeatureRegistry<OperatorDescriptor>,runtime:string,budget:ResourceBudget):IndependentGraphPlan {
 if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||graph.nodes.length===0)throw new PlanningError('invalid-graph','Empty or malformed execution graph');
 // Snapshot and validate all identities/endpoints before resolving any metadata.
 const nodes:GraphNode[]=Array.from(graph.nodes,(node:GraphNode)=>{
  if(!node||typeof node.id!=='string'||!node.id||typeof node.featureId!=='string'||!node.featureId)throw new PlanningError('invalid-graph','Invalid graph node');
  return Object.freeze({id:node.id,featureId:node.featureId});
 });
 const byId=new Map<string,GraphNode>(),adjacent=new Map<string,string[]>();
 for(const node of nodes){if(byId.has(node.id))throw new PlanningError('invalid-graph',`Duplicate node: ${node.id}`);byId.set(node.id,node);adjacent.set(node.id,[]);}
 const edges:GraphEdge[]=Array.from(graph.edges,(edge:GraphEdge)=>{
  if(!edge||!edge.from||!edge.to||typeof edge.from.node!=='string'||typeof edge.to.node!=='string'||typeof edge.from.port!=='string'||!edge.from.port||typeof edge.to.port!=='string'||!edge.to.port||!byId.has(edge.from.node)||!byId.has(edge.to.node))throw new PlanningError('invalid-graph','Edge refers to an unknown node');
  const snapshot=Object.freeze({from:Object.freeze({node:edge.from.node,port:edge.from.port}),to:Object.freeze({node:edge.to.node,port:edge.to.port}),queueCapacity:edge.queueCapacity});
  adjacent.get(snapshot.from.node)!.push(snapshot.to.node);adjacent.get(snapshot.to.node)!.push(snapshot.from.node);
  return snapshot;
 });
 const workerBudget=Object.freeze({...budget});
 const components:string[][]=[],seen=new Set<string>();
 for(const node of nodes){
  if(seen.has(node.id))continue;
  const membership=[node.id];seen.add(node.id);
  for(let cursor=0;cursor<membership.length;cursor++)for(const neighbor of adjacent.get(membership[cursor]!)!){if(!seen.has(neighbor)){seen.add(neighbor);membership.push(neighbor);}}
  membership.sort(compare);components.push(membership);
 }
 // Ordinary code-unit ordering avoids locale-dependent scheduling/identities.
 components.sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b)));
 const componentByNode=new Map<string,number>();components.forEach((members,index)=>{for(const id of members)componentByNode.set(id,index);});
 const componentEdges:GraphEdge[][]=components.map(()=>[]);
 for(const edge of edges)componentEdges[componentByNode.get(edge.from.node)!]!.push(edge);
 const edgeKey=(edge:GraphEdge)=>JSON.stringify([edge.from.node,edge.from.port,edge.to.node,edge.to.port,edge.queueCapacity]);
 const warnings=['Independent-component planning does not execute operators, prove Native compatibility or split connected temporal/stateful paths'];
 let memory=0,packets=0,knownCpu=0,unknownCpu=false;
 const units=components.map((members,index):IndependentGraphWorkUnit=>{
  const planned=planGraph({nodes:members.map(id=>byId.get(id)!),edges:componentEdges[index]!.sort((a,b)=>compare(edgeKey(a),edgeKey(b)))},registry,runtime,workerBudget);
  const estimatedCpuTimeMs=cpu(planned.nodes),id='component:'+JSON.stringify(members);
  memory=add(memory,planned.minimumMemoryBytes,'Aggregate memory estimate');packets=add(packets,planned.reservedPacketSlots,'Aggregate packet slots');
  if(estimatedCpuTimeMs===null)unknownCpu=true;else knownCpu=add(knownCpu,estimatedCpuTimeMs,'Aggregate CPU estimate');
  warnings.push(...planned.warnings);
  if(estimatedCpuTimeMs!==null&&estimatedCpuTimeMs>workerBudget.maxCpuTimeMs)warnings.push(`CPU estimate exceeds a work unit budget; connected component cannot be automatically split: ${id}`);
  const traits=Object.freeze({state:planned.nodes.some(node=>node.operator.traits.state==='stateful')?'stateful' as const:'stateless' as const,access:planned.nodes.some(node=>node.operator.traits.access==='sequential')?'sequential' as const:'seekable' as const,checkpointable:planned.nodes.every(node=>node.operator.traits.checkpointable),temporal:planned.nodes.some(node=>node.operator.traits.temporal),deterministic:planned.nodes.every(node=>node.operator.traits.deterministic),minimumMemoryBytes:planned.minimumMemoryBytes,estimatedCpuTimeMs});
  return Object.freeze({id,nodeIds:Object.freeze(members),graph:planned,dependencies:Object.freeze([]),minimumMemoryBytes:planned.minimumMemoryBytes,reservedPacketSlots:planned.reservedPacketSlots,estimatedCpuTimeMs,traits});
 });
 return Object.freeze({workUnits:Object.freeze(units),aggregate:Object.freeze({minimumMemoryBytes:memory,reservedPacketSlots:packets,estimatedCpuTimeMs:unknownCpu?null:knownCpu}),warnings:Object.freeze(warnings)});
}
