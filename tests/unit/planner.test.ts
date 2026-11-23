import { expect, it } from 'vitest';
import { FeatureRegistry, FeatureResolutionError, planGraph, PlanningError } from '@edge-ffmpeg/core';
import type { OperatorDescriptor, ExecutionGraph, ResourceBudget } from '@edge-ffmpeg/core';
const budget: ResourceBudget = { maxResidentBytes: 100, maxBufferBytes: 10, maxCpuTimeMs: 100, maxPendingPackets: 4 };
function operator(id: string, kind: OperatorDescriptor['kind'], changes: Partial<OperatorDescriptor> = {}): OperatorDescriptor {
  return { id, kind, status: 'partial', runtimes: ['cloudflare'], testCases: [],
    inputs: kind === 'source' ? [] : [{ name: 'in', type: 'packet' }],
    outputs: kind === 'sink' ? [] : [{ name: 'out', type: 'packet' }],
    traits: { state: 'stateless', access: 'sequential', checkpointable: false, temporal: false, deterministic: true, minimumMemoryBytes: 10, estimatedCpuTimeMs: null }, ...changes };
}
function fixture() {
  const registry = new FeatureRegistry<OperatorDescriptor>();
  registry.register(operator('test.source', 'source')); registry.register(operator('test.sink', 'sink'));
  const graph: ExecutionGraph = { nodes: [{ id: 'sink', featureId: 'test.sink' }, { id: 'source', featureId: 'test.source' }], edges: [{ from: { node: 'source', port: 'out' }, to: { node: 'sink', port: 'in' }, queueCapacity: 2 }] };
  return { registry, graph };
}
it('resolves features, orders nodes and reserves aggregate queue slots', () => {
  const { registry, graph } = fixture();
  const plan = planGraph(graph, registry, 'cloudflare', budget);
  expect(plan.nodes.map(node => node.id)).toEqual(['source', 'sink']);
  expect(plan.minimumMemoryBytes).toBe(20); expect(plan.reservedPacketSlots).toBe(2);
  expect(plan.warnings).toContain('Partial implementation: test.source');
  expect(Object.isFrozen(plan.edges[0]?.from)).toBe(true);
});
it('separates missing, unimplemented and runtime-blocked features', () => {
  const registry = new FeatureRegistry<OperatorDescriptor>();
  registry.register(operator('available', 'source'));
  registry.register(operator('absent', 'source', { status: 'unimplemented' }));
  registry.register(operator('device', 'source', { status: 'runtime-blocked', reason: 'Physical device access unavailable' }));
  for (const [id, runtime, code] of [['available', 'node', 'runtime-blocked'], ['unknown', 'cloudflare', 'unknown-feature'], ['absent', 'cloudflare', 'unimplemented'], ['device', 'cloudflare', 'runtime-blocked'], ['absent', 'node', 'unimplemented']] as const) {
    try { registry.resolve(id, runtime); throw new Error('Expected resolution failure'); }
    catch (error) { expect(error).toBeInstanceOf(FeatureResolutionError); expect((error as FeatureResolutionError).code).toBe(code); }
  }
});
it('snapshots descriptors and requires references for compatibility claims', () => {
  const registry = new FeatureRegistry<OperatorDescriptor>();
  const descriptor = operator('test', 'source'); registry.register(descriptor);
  expect(() => registry.register(descriptor)).toThrow('Duplicate');
  expect(() => registry.register(operator('claim', 'source', { status: 'bitexact' }))).toThrow('test references');
  expect(() => registry.register(operator('blocked', 'source', { status: 'runtime-blocked' }))).toThrow('reason');
  expect(registry.get('test')).not.toBe(descriptor);
  expect(Object.isFrozen(registry.get('test')?.traits)).toBe(true);
  expect(() => { (registry.get('test')!.runtimes as string[]).push('node'); }).toThrow();
  const exotic = { ...operator('map', 'source'), extra: new Map() };
  expect(() => registry.register(exotic)).toThrow('plain metadata');
});
it('rejects malformed connections, duplicate nodes and missing required inputs', () => {
  const { registry, graph } = fixture();
  const invalid: ExecutionGraph[] = [
    { nodes: [], edges: [] },
    { nodes: [graph.nodes[0]!, graph.nodes[0]!], edges: [] },
    { ...graph, edges: [] },
    { ...graph, edges: [{ ...graph.edges[0]!, from: { node: 'missing', port: 'out' } }] },
    { ...graph, edges: [{ ...graph.edges[0]!, to: { node: 'sink', port: 'missing' } }] },
    { ...graph, edges: [graph.edges[0]!, graph.edges[0]!] }
  ];
  for (const candidate of invalid) expect(() => planGraph(candidate, registry, 'cloudflare', budget)).toThrow(PlanningError);
  registry.register(operator('video', 'sink', { inputs: [{ name: 'in', type: 'video-frame' }] }));
  expect(() => planGraph({ ...graph, nodes: [graph.nodes[1]!, { id: 'sink', featureId: 'video' }] }, registry, 'cloudflare', budget)).toThrow('incompatible');
});
it('detects cycles without recursive traversal', () => {
  const registry = new FeatureRegistry<OperatorDescriptor>(); registry.register(operator('filter', 'filter'));
  expect(() => planGraph({ nodes: [{ id: 'a', featureId: 'filter' }, { id: 'b', featureId: 'filter' }], edges: [
    { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' }, queueCapacity: 1 },
    { from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' }, queueCapacity: 1 }
  ] }, registry, 'cloudflare', budget)).toThrow('cycle');
});
it('rejects impossible lower-bound memory and aggregate queue budgets', () => {
  const { registry, graph } = fixture();
  expect(() => planGraph(graph, registry, 'cloudflare', { ...budget, maxResidentBytes: 15 })).toThrow('memory');
  expect(() => planGraph(graph, registry, 'cloudflare', { ...budget, maxPendingPackets: 1 })).toThrow('Aggregate');
  expect(() => planGraph({ ...graph, edges: [{ ...graph.edges[0]!, queueCapacity: 0 }] }, registry, 'cloudflare', budget)).toThrow('capacity');
});
it('requires explicit fanout pads and a single producer for each input', () => {
  const { registry, graph } = fixture();
  expect(() => planGraph({ nodes: [...graph.nodes, { id: 'other', featureId: 'test.sink' }], edges: [...graph.edges, { ...graph.edges[0]!, to: { node: 'other', port: 'in' } }] }, registry, 'cloudflare', budget)).toThrow('Fanout');
  expect(() => planGraph({ nodes: [...graph.nodes, { id: 'other', featureId: 'test.source' }], edges: [...graph.edges, { ...graph.edges[0]!, from: { node: 'other', port: 'out' } }] }, registry, 'cloudflare', budget)).toThrow('Multiple producers');
});
it('rejects duplicate port definitions and invalid resource estimates', () => {
  for (const descriptor of [
    operator('bad', 'source', { outputs: [{ name: 'out', type: 'packet' }, { name: 'out', type: 'packet' }] }),
    operator('bad', 'source', { traits: { ...operator('base', 'source').traits, minimumMemoryBytes: -1 } })
  ]) {
    const registry = new FeatureRegistry<OperatorDescriptor>(); registry.register(descriptor);
    expect(() => planGraph({ nodes: [{ id: 'a', featureId: 'bad' }], edges: [] }, registry, 'cloudflare', budget)).toThrow(PlanningError);
  }
});
it('rejects missing or malformed required budget fields instead of bypassing limits', () => {
 const {registry,graph}=fixture();
 for(const key of ['maxResidentBytes','maxBufferBytes','maxCpuTimeMs','maxPendingPackets'] as const){
  const missing={...budget};delete (missing as Partial<ResourceBudget>)[key];
  for(const candidate of [missing,{...budget,[key]:undefined},{...budget,[key]:NaN},{...budget,[key]:Infinity},{...budget,[key]:1.5},{...budget,[key]:0}]){
   expect(()=>planGraph(graph,registry,'cloudflare',candidate)).toThrowError(expect.objectContaining({code:'resource-budget'}));
  }
 }
});
it('validates all execution trait enums and booleans before planning', () => {
 const base=operator('bad','source');
 const invalid:Record<string,unknown>[]=[{state:'unknown'},{state:0},{access:'random'},{access:false},...['checkpointable','temporal','deterministic'].flatMap(key=>[{[key]:undefined},{[key]:0},{[key]:'false'}])];
 for(const patch of invalid){
  const registry=new FeatureRegistry<OperatorDescriptor>();registry.register({...base,traits:{...base.traits,...patch}});
  expect(()=>planGraph({nodes:[{id:'a',featureId:'bad'}],edges:[]},registry,'cloudflare',budget)).toThrowError(expect.objectContaining({code:'invalid-operator'}));
 }
});
it('rejects malformed runtime graph identities and shapes with a planning diagnostic',()=>{
 const {registry,graph}=fixture();
 const invalid:unknown[]=[null,{}, {nodes:null,edges:[]},{nodes:[null],edges:[]},{nodes:[{id:4,featureId:'test.source'}],edges:[]},{nodes:[{id:'a',featureId:4}],edges:[]},{...graph,edges:[null]},{...graph,edges:[{from:null,to:{node:'sink',port:'in'},queueCapacity:1}]},{...graph,edges:[{...graph.edges[0],from:{node:'source',port:3}}]}];
 for(const value of invalid)expect(()=>planGraph(value as ExecutionGraph,registry,'cloudflare',budget)).toThrowError(expect.objectContaining({code:'invalid-graph'}));
});
it('rejects nonboolean optional ports and unsafe resource estimates',()=>{
 const base=operator('bad','source');
 for(const patch of [{outputs:[{name:'out',type:'packet',optional:'true'}]},...[-1,NaN,Infinity,1.25,Number.MAX_SAFE_INTEGER+1].flatMap(value=>[{traits:{...base.traits,minimumMemoryBytes:value}},{traits:{...base.traits,estimatedCpuTimeMs:value}}])]){
  const registry=new FeatureRegistry<OperatorDescriptor>();registry.register({...base,...patch} as OperatorDescriptor);
  expect(()=>planGraph({nodes:[{id:'a',featureId:'bad'}],edges:[]},registry,'cloudflare',budget)).toThrowError(expect.objectContaining({code:'invalid-operator'}));
 }
});
it('snapshots graph identities and budget values before feature resolution',()=>{
 const {registry,graph}=fixture(),mutable={nodes:graph.nodes.map(node=>({...node})),edges:graph.edges.map(edge=>({...edge,from:{...edge.from},to:{...edge.to}}))},limits={...budget};
 const original=registry.resolve.bind(registry);let changed=false;
 registry.resolve=(id,runtime)=>{if(!changed){changed=true;mutable.nodes[1]!.id='changed';mutable.edges[0]!.from.node='changed';limits.maxPendingPackets=1;}return original(id,runtime);};
 const result=planGraph(mutable,registry,'cloudflare',limits);
 expect(result.nodes.map(node=>node.id)).toEqual(['source','sink']);expect(result.edges[0]!.from.node).toBe('source');expect(result.reservedPacketSlots).toBe(2);
 mutable.edges[0]!.from.node='later';expect(result.edges[0]!.from.node).toBe('source');
});
it('rejects overflowed lower-bound sums while retaining valid unknown CPU estimates',()=>{
 const registry=new FeatureRegistry<OperatorDescriptor>();
 registry.register(operator('large','source',{outputs:[],traits:{...operator('base','source').traits,minimumMemoryBytes:Number.MAX_SAFE_INTEGER}}));
 const limits={...budget,maxResidentBytes:Number.MAX_SAFE_INTEGER};
 const one=planGraph({nodes:[{id:'a',featureId:'large'}],edges:[]},registry,'cloudflare',limits);expect(one.minimumMemoryBytes).toBe(Number.MAX_SAFE_INTEGER);expect(one.warnings).toContain('CPU estimate unavailable: a');
 expect(()=>planGraph({nodes:[{id:'a',featureId:'large'},{id:'b',featureId:'large'}],edges:[]},registry,'cloudflare',limits)).toThrowError(expect.objectContaining({code:'resource-budget'}));
});
it('checks safe aggregate queue arithmetic without allocating queue storage',()=>{
 const {registry,graph}=fixture(),limits={...budget,maxPendingPackets:Number.MAX_SAFE_INTEGER};
 const first={...graph.edges[0]!,queueCapacity:Number.MAX_SAFE_INTEGER};
 expect(planGraph({...graph,edges:[first]},registry,'cloudflare',limits).reservedPacketSlots).toBe(Number.MAX_SAFE_INTEGER);
 expect(()=>planGraph({nodes:[...graph.nodes,{id:'source2',featureId:'test.source'},{id:'sink2',featureId:'test.sink'}],edges:[first,{from:{node:'source2',port:'out'},to:{node:'sink2',port:'in'},queueCapacity:1}]},registry,'cloudflare',limits)).toThrowError(expect.objectContaining({code:'resource-budget'}));
});
