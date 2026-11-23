import { FeatureRegistry } from './registry.js';
import type { FeatureDescriptor } from './registry.js';
import type { ResourceBudget } from './index.js';
export type MediaPortType = 'packet' | 'video-frame' | 'audio-frame' | 'subtitle-frame';
export interface OperatorPort { readonly name: string; readonly type: MediaPortType; readonly optional?: boolean }
export interface OperatorDescriptor extends FeatureDescriptor {
  readonly kind: 'source' | 'demux' | 'decode' | 'filter' | 'encode' | 'mux' | 'sink';
  readonly inputs: readonly OperatorPort[];
  readonly outputs: readonly OperatorPort[];
  readonly traits: {
    readonly state: 'stateless' | 'stateful';
    readonly access: 'seekable' | 'sequential';
    readonly checkpointable: boolean;
    readonly temporal: boolean;
    readonly deterministic: boolean;
    /** Lower bound only. A feasible plan still requires dynamic budget enforcement. */
    readonly minimumMemoryBytes: number;
    readonly estimatedCpuTimeMs: number | null;
  };
}
export interface GraphNode { readonly id: string; readonly featureId: string }
export interface GraphEdge {
  readonly from: { readonly node: string; readonly port: string };
  readonly to: { readonly node: string; readonly port: string };
  readonly queueCapacity: number;
}
export interface ExecutionGraph { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }
export interface PlannedGraph {
  readonly nodes: readonly (GraphNode & { readonly operator: OperatorDescriptor })[];
  readonly edges: readonly GraphEdge[];
  readonly minimumMemoryBytes: number;
  readonly reservedPacketSlots: number;
  readonly warnings: readonly string[];
}
export class PlanningError extends Error {
  constructor(readonly code: 'invalid-graph' | 'invalid-operator' | 'resource-budget' | 'cycle', message: string) { super(message); }
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function nonnegative(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function validateOperator(operator: OperatorDescriptor): void {
  if (!Array.isArray(operator.inputs) || !Array.isArray(operator.outputs)) throw new PlanningError('invalid-operator', `Invalid ports in ${operator.id}`);
  for (const ports of [operator.inputs, operator.outputs]) {
    for (const port of ports) if (!port || !text(port.name) || !['packet', 'video-frame', 'audio-frame', 'subtitle-frame'].includes(port.type) || (port.optional !== undefined && typeof port.optional !== 'boolean')) throw new PlanningError('invalid-operator', `Invalid port in ${operator.id}`);
    if (new Set(ports.map(port => port.name)).size !== ports.length) throw new PlanningError('invalid-operator', `Duplicate ports in ${operator.id}`);
  }
  if (!['source', 'demux', 'decode', 'filter', 'encode', 'mux', 'sink'].includes(operator.kind) || (operator.kind === 'source' && operator.inputs.length > 0) || (operator.kind === 'sink' && operator.outputs.length > 0)) throw new PlanningError('invalid-operator', `Invalid operator kind or terminal ports in ${operator.id}`);
  const traits = operator.traits;
  if (!traits || !['stateless', 'stateful'].includes(traits.state) || !['seekable', 'sequential'].includes(traits.access) || [traits.checkpointable, traits.temporal, traits.deterministic].some(value => typeof value !== 'boolean')) throw new PlanningError('invalid-operator', `Invalid execution traits in ${operator.id}`);
  if (!nonnegative(operator.traits.minimumMemoryBytes) || (operator.traits.estimatedCpuTimeMs !== null && !nonnegative(operator.traits.estimatedCpuTimeMs))) throw new PlanningError('invalid-operator', `Invalid resource estimate in ${operator.id}`);
}
/** Single-worker structural/resource planning only. Does not select streams, negotiate formats or run operators. */
export function planGraph(graph: ExecutionGraph, registry: FeatureRegistry<OperatorDescriptor>, runtime: string, budget: ResourceBudget): PlannedGraph {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.nodes.length || !text(runtime)) throw new PlanningError('invalid-graph', 'Invalid or empty graph/runtime');
  if (!budget || typeof budget !== 'object') throw new PlanningError('resource-budget', 'Invalid budget');
  const limits = {maxResidentBytes: budget.maxResidentBytes, maxBufferBytes: budget.maxBufferBytes, maxCpuTimeMs: budget.maxCpuTimeMs, maxPendingPackets: budget.maxPendingPackets};
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new PlanningError('resource-budget', 'Invalid budget');
  if (limits.maxBufferBytes > limits.maxResidentBytes) throw new PlanningError('resource-budget', 'Buffer limit exceeds resident limit');
  // Snapshot only primitive identities before resolving metadata. Never retain
  // caller-owned edge objects or coerce object/number identities into strings.
  const graphNodes = Array.from(graph.nodes, node => {
    if (!node) throw new PlanningError('invalid-graph', 'Invalid node');
    const {id, featureId} = node;
    if (!text(id) || !text(featureId)) throw new PlanningError('invalid-graph', 'Invalid node identity');
    return {id, featureId};
  });
  const graphEdges = Array.from(graph.edges, edge => {
    if (!edge || !edge.from || !edge.to) throw new PlanningError('invalid-graph', 'Invalid edge');
    const from = {node: edge.from.node, port: edge.from.port}, to = {node: edge.to.node, port: edge.to.port}, queueCapacity = edge.queueCapacity;
    if (![from.node, from.port, to.node, to.port].every(text)) throw new PlanningError('invalid-graph', 'Invalid edge identity');
    return {from, to, queueCapacity};
  });
  const resolved = new Map<string, GraphNode & { operator: OperatorDescriptor }>();
  let minimumMemoryBytes = 0;
  const warnings: string[] = [];
  for (const node of graphNodes) {
    if (!node.id || resolved.has(node.id)) throw new PlanningError('invalid-graph', `Invalid or duplicate node: ${node.id}`);
    const operator = registry.resolve(node.featureId, runtime);
    validateOperator(operator);
    minimumMemoryBytes += operator.traits.minimumMemoryBytes;
    if (!Number.isSafeInteger(minimumMemoryBytes) || minimumMemoryBytes > limits.maxResidentBytes) throw new PlanningError('resource-budget', 'Minimum operator memory exceeds budget');
    if (operator.status === 'partial') warnings.push(`Partial implementation: ${operator.id}`);
    if (operator.traits.estimatedCpuTimeMs !== null && operator.traits.estimatedCpuTimeMs > limits.maxCpuTimeMs) warnings.push(`CPU estimate exceeds a work unit budget; partitioning required: ${node.id}`);
    if (operator.traits.estimatedCpuTimeMs === null) warnings.push(`CPU estimate unavailable: ${node.id}`);
    resolved.set(node.id, Object.freeze({ id: node.id, featureId: node.featureId, operator }));
  }
  const incoming = new Map<string, number>([...resolved.keys()].map(id => [id, 0]));
  const successors = new Map<string, string[]>();
  const connectedOutputs = new Map<string, Set<string>>();
  const connectedInputs = new Map<string, Set<string>>();
  let reservedPacketSlots = 0;
  const edges: GraphEdge[] = [];
  for (const edge of graphEdges) {
    const source = resolved.get(edge.from.node), target = resolved.get(edge.to.node);
    if (!source || !target) throw new PlanningError('invalid-graph', 'Edge refers to an unknown node');
    const output = source.operator.outputs.find(port => port.name === edge.from.port);
    const input = target.operator.inputs.find(port => port.name === edge.to.port);
    if (!output || !input || output.type !== input.type) throw new PlanningError('invalid-graph', 'Missing or incompatible media ports');
    const published = connectedOutputs.get(source.id) ?? new Set<string>();
    if (published.has(output.name)) throw new PlanningError('invalid-graph', 'Fanout requires explicit output pads and ownership handling');
    published.add(output.name); connectedOutputs.set(source.id, published);
    const connected = connectedInputs.get(target.id) ?? new Set<string>();
    if (connected.has(input.name)) throw new PlanningError('invalid-graph', `Multiple producers for ${target.id}:${input.name}`);
    connected.add(input.name); connectedInputs.set(target.id, connected);
    if (!Number.isSafeInteger(edge.queueCapacity) || edge.queueCapacity <= 0) throw new PlanningError('resource-budget', 'Invalid edge queue capacity');
    reservedPacketSlots += edge.queueCapacity;
    if (!Number.isSafeInteger(reservedPacketSlots) || reservedPacketSlots > limits.maxPendingPackets) throw new PlanningError('resource-budget', 'Aggregate queue capacities exceed packet budget');
    incoming.set(target.id, incoming.get(target.id)! + 1);
    const next = successors.get(source.id) ?? []; next.push(target.id); successors.set(source.id, next);
    edges.push(Object.freeze({ from: Object.freeze({ ...edge.from }), to: Object.freeze({ ...edge.to }), queueCapacity: edge.queueCapacity }));
  }
  for (const node of resolved.values()) {
    for (const port of node.operator.outputs) if (!port.optional && !connectedOutputs.get(node.id)?.has(port.name)) throw new PlanningError('invalid-graph', `Unconnected output: ${node.id}:${port.name}`);
    for (const port of node.operator.inputs) if (!port.optional && !connectedInputs.get(node.id)?.has(port.name)) throw new PlanningError('invalid-graph', `Unconnected input: ${node.id}:${port.name}`);
  }
  // Iterative Kahn traversal avoids recursive stack growth for untrusted graphs.
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  const nodes: Array<GraphNode & { operator: OperatorDescriptor }> = [];
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const id = ready[cursor]!; nodes.push(resolved.get(id)!);
    for (const target of successors.get(id) ?? []) {
      const remaining = incoming.get(target)! - 1; incoming.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  if (nodes.length !== resolved.size) throw new PlanningError('cycle', 'Execution graph contains a cycle');
  warnings.push('Memory estimates exclude queues, in-flight frames and runtime overhead; execution must enforce dynamic budgets');
  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges), minimumMemoryBytes, reservedPacketSlots, warnings: Object.freeze(warnings) });
}
