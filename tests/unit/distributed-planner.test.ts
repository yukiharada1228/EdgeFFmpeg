import {expect,it} from 'vitest';
import {FeatureRegistry,PlanningError,FeatureResolutionError,planGraph} from '@edge-ffmpeg/core';
import type {ExecutionGraph,OperatorDescriptor,ResourceBudget} from '@edge-ffmpeg/core';
import {planIndependentGraph} from '../../packages/core/src/distributed-planner.js';
const budget:ResourceBudget={maxResidentBytes:12,maxBufferBytes:4,maxCpuTimeMs:100,maxPendingPackets:2};
function operator(id:string,kind:OperatorDescriptor['kind'],traits:Partial<OperatorDescriptor['traits']>={},ports:Partial<Pick<OperatorDescriptor,'inputs'|'outputs'>>={}):OperatorDescriptor{
 return {id,kind,status:'partial',runtimes:['cloudflare'],testCases:[],inputs:kind==='source'?[]:[{name:'in',type:'packet'}],outputs:kind==='sink'?[]:[{name:'out',type:'packet'}],traits:{state:'stateless',access:'seekable',checkpointable:true,temporal:false,deterministic:true,minimumMemoryBytes:6,estimatedCpuTimeMs:10,...traits},...ports};
}
function registry(...operators:OperatorDescriptor[]){const result=new FeatureRegistry<OperatorDescriptor>();for(const descriptor of operators)result.register(descriptor);return result;}
const edge=(from:string,to:string,queueCapacity=2)=>({from:{node:from,port:'out'},to:{node:to,port:'in'},queueCapacity});
function branches(ids:readonly(readonly[string,string])[]=[['source-a','sink-a'],['source-b','sink-b']]):ExecutionGraph{return {nodes:ids.flatMap(([source,sink])=>[{id:sink,featureId:'sink'},{id:source,featureId:'source'}]),edges:ids.map(([source,sink])=>edge(source,sink))};}
const basic=()=>registry(operator('source','source'),operator('sink','sink'));
function code(action:()=>unknown,expected:PlanningError['code']){try{action();throw Error('Expected planning rejection');}catch(error){expect(error).toBeInstanceOf(PlanningError);expect((error as PlanningError).code).toBe(expected);}}

it('automatically isolates disconnected components whose aggregate exceeds one worker budget',()=>{
 const graph=branches(),features=basic();expect(()=>planGraph(graph,features,'cloudflare',budget)).toThrow(PlanningError);
 const plan=planIndependentGraph(graph,features,'cloudflare',budget);expect(plan.workUnits).toHaveLength(2);expect(plan.aggregate).toMatchObject({minimumMemoryBytes:24,reservedPacketSlots:4,estimatedCpuTimeMs:40});
 expect(plan.workUnits.map(unit=>[...unit.nodeIds].sort())).toEqual([['sink-a','source-a'],['sink-b','source-b']]);
 for(const unit of plan.workUnits){expect(unit.dependencies).toEqual([]);expect(unit.minimumMemoryBytes).toBe(12);expect(unit.reservedPacketSlots).toBe(2);expect(unit.estimatedCpuTimeMs).toBe(20);expect(unit.graph.nodes.map(node=>node.id)).toEqual([unit.nodeIds.find(id=>id.startsWith('source')),unit.nodeIds.find(id=>id.startsWith('sink'))]);}
});

it('keeps a connected temporal stateful chain indivisible regardless of checkpoint traits',()=>{
 const features=registry(operator('source','source',{minimumMemoryBytes:4}),operator('history','filter',{minimumMemoryBytes:4,state:'stateful',access:'sequential',temporal:true,checkpointable:false,deterministic:false}),operator('sink','sink',{minimumMemoryBytes:4}));
 const graph:ExecutionGraph={nodes:[{id:'sink',featureId:'sink'},{id:'history',featureId:'history'},{id:'source',featureId:'source'}],edges:[edge('source','history',1),edge('history','sink',1)]};
 const plan=planIndependentGraph(graph,features,'cloudflare',budget);expect(plan.workUnits).toHaveLength(1);expect(new Set(plan.workUnits[0]!.nodeIds)).toEqual(new Set(['source','history','sink']));expect(plan.workUnits[0]!.traits).toMatchObject({state:'stateful',access:'sequential',checkpointable:false,temporal:true,deterministic:false});
 code(()=>planIndependentGraph(graph,features,'cloudflare',{...budget,maxResidentBytes:11}),'resource-budget');
 code(()=>planIndependentGraph(graph,features,'cloudflare',{...budget,maxPendingPackets:1}),'resource-budget');
});

it('does not split shared-source branches even with explicit independent output pads',()=>{
 const features=registry(operator('split','source',{minimumMemoryBytes:4},{outputs:[{name:'left',type:'packet'},{name:'right',type:'packet'}]}),operator('sink','sink',{minimumMemoryBytes:4}));
 const graph:ExecutionGraph={nodes:[{id:'source',featureId:'split'},{id:'left',featureId:'sink'},{id:'right',featureId:'sink'}],edges:[{...edge('source','left',1),from:{node:'source',port:'left'}},{...edge('source','right',1),from:{node:'source',port:'right'}}]};
 expect(planIndependentGraph(graph,features,'cloudflare',budget).workUnits).toHaveLength(1);
 code(()=>planIndependentGraph(graph,features,'cloudflare',{...budget,maxResidentBytes:8}),'resource-budget');
 const implicit={...graph,edges:graph.edges.map(item=>({...item,from:{node:'source',port:'left'}}))};code(()=>planIndependentGraph(implicit,features,'cloudflare',budget),'invalid-graph');
});

it('uses injective deterministic unit identities for delimiter, Unicode and prototype-like IDs',()=>{
 const graph=branches([['a,b','c'],['a','b,c'],['__proto__','音声😀']]),features=basic();
 const first=planIndependentGraph(graph,features,'cloudflare',budget),second=planIndependentGraph({nodes:[...graph.nodes].reverse(),edges:[...graph.edges].reverse()},features,'cloudflare',budget);
 expect(first.workUnits).toHaveLength(3);expect(new Set(first.workUnits.map(unit=>unit.id)).size).toBe(3);expect(second).toEqual(first);expect(first.workUnits.some(unit=>unit.nodeIds.includes('__proto__')&&unit.nodeIds.includes('音声😀'))).toBe(true);
});

it('retains snapshots and freezes partition metadata without freezing caller-owned graphs',()=>{
 const nodes=[{id:'source',featureId:'source'},{id:'sink',featureId:'sink'}],edges=[edge('source','sink')],graph={nodes,edges};
 const plan=planIndependentGraph(graph,basic(),'cloudflare',budget),serialized=JSON.stringify(plan);
 nodes[0]!.id='mutated';edges[0]!.from.node='mutated';edges[0]!.queueCapacity=999;nodes.push({id:'new',featureId:'source'});expect(JSON.stringify(plan)).toBe(serialized);
 expect(Object.isFrozen(graph)).toBe(false);expect(Object.isFrozen(plan)).toBe(true);expect(Object.isFrozen(plan.workUnits)).toBe(true);expect(Object.isFrozen(plan.aggregate)).toBe(true);expect(Object.isFrozen(plan.warnings)).toBe(true);
 const unit=plan.workUnits[0]!;for(const value of [unit,unit.nodeIds,unit.dependencies,unit.traits,unit.graph,unit.graph.nodes,unit.graph.edges,unit.graph.edges[0]!.from])expect(Object.isFrozen(value)).toBe(true);
});

it.each(['empty','duplicate','dangling','duplicate-edge','missing-input','bad-port','bad-type'] as const)('rejects structural graph errors before returning work units: %s',variant=>{
 const graph=branches([['source','sink']]);let candidate:ExecutionGraph=graph;const features=basic();
 if(variant==='empty')candidate={nodes:[],edges:[]};
 else if(variant==='duplicate')candidate={...graph,nodes:[...graph.nodes,graph.nodes[0]!]};
 else if(variant==='dangling')candidate={...graph,edges:[edge('source','absent')]};
 else if(variant==='duplicate-edge')candidate={...graph,edges:[...graph.edges,...graph.edges]};
 else if(variant==='missing-input')candidate={...graph,edges:[]};
 else if(variant==='bad-port')candidate={...graph,edges:[{...graph.edges[0]!,to:{node:'sink',port:'missing'}}]};
 else{features.register(operator('video','sink',{}, {inputs:[{name:'in',type:'video-frame'}]}));candidate={...graph,nodes:graph.nodes.map(node=>node.id==='sink'?{...node,featureId:'video'}:node)};}
 code(()=>planIndependentGraph(candidate,features,'cloudflare',budget),'invalid-graph');
});

it('rejects a connected cycle instead of calling it an independent work unit',()=>{
 const features=registry(operator('filter','filter',{minimumMemoryBytes:1})),graph:ExecutionGraph={nodes:[{id:'a',featureId:'filter'},{id:'b',featureId:'filter'}],edges:[edge('a','b',1),edge('b','a',1)]};code(()=>planIndependentGraph(graph,features,'cloudflare',budget),'cycle');
});

it.each([['state','invalid'],['access','network'],['checkpointable',1],['temporal',null],['deterministic',undefined],['minimumMemoryBytes',-1],['estimatedCpuTimeMs',Infinity],['estimatedCpuTimeMs',0.5]] as const)('validates operator traits in every component: %s = %s',(name,value)=>{
 const source=operator('source','source');const malformed={...source,traits:Object.assign({},source.traits,{[name]:value})},features=registry(malformed,operator('sink','sink'));
 code(()=>planIndependentGraph(branches([['source','sink']]),features,'cloudflare',budget),'invalid-operator');
});

it('propagates unknown CPU estimates and warns for a known component total above the worker budget',()=>{
 const unknown=registry(operator('source','source',{estimatedCpuTimeMs:null}),operator('sink','sink'));
 const plan=planIndependentGraph(branches(),unknown,'cloudflare',budget);expect(plan.aggregate.estimatedCpuTimeMs).toBeNull();expect(plan.workUnits.every(unit=>unit.estimatedCpuTimeMs===null)).toBe(true);expect(plan.warnings.join(' ')).toMatch(/CPU.*(unknown|unavailable)/i);
 const known=registry(operator('source','source',{estimatedCpuTimeMs:60}),operator('sink','sink',{estimatedCpuTimeMs:60}));const oversized=planIndependentGraph(branches([['source','sink']]),known,'cloudflare',budget);expect(oversized.workUnits).toHaveLength(1);expect(oversized.workUnits[0]!.estimatedCpuTimeMs).toBe(120);expect(oversized.warnings.join(' ')).toMatch(/CPU/i);
});

it('retains a known component estimate when another independent component is unknown',()=>{
 const features=basic();features.register(operator('unknown-source','source',{estimatedCpuTimeMs:null}));const graph=branches();
 const plan=planIndependentGraph({...graph,nodes:graph.nodes.map(node=>node.id==='source-a'?{...node,featureId:'unknown-source'}:node)},features,'cloudflare',budget);
 expect(plan.aggregate.estimatedCpuTimeMs).toBeNull();expect(plan.workUnits.map(unit=>unit.estimatedCpuTimeMs)).toEqual([null,20]);
});

it.each(['memory','queues','cpu-unit','cpu-aggregate'] as const)('rejects unsafe estimate addition rather than losing integer precision: %s',variant=>{
 const maximum=Number.MAX_SAFE_INTEGER,wide={...budget,maxResidentBytes:maximum,maxPendingPackets:maximum,maxCpuTimeMs:maximum};
 const features=registry(operator('source','source',{minimumMemoryBytes:variant==='memory'?maximum:0,estimatedCpuTimeMs:variant.startsWith('cpu')?maximum:0}),operator('sink','sink',{minimumMemoryBytes:0,estimatedCpuTimeMs:variant==='cpu-unit'?1:0}));
 const graph=branches(variant==='cpu-unit'?[['source','sink']]:undefined);const candidate=variant==='queues'?{...graph,edges:graph.edges.map(item=>({...item,queueCapacity:maximum}))}:graph;
 code(()=>planIndependentGraph(candidate,features,'cloudflare',wide),'resource-budget');
});

it.each([0,-1,NaN,1.5])('rejects malformed worker budgets: %s',value=>{code(()=>planIndependentGraph(branches(),basic(),'cloudflare',{...budget,maxPendingPackets:value}),'resource-budget');});
it('preserves runtime capability resolution errors instead of manufacturing a runnable unit',()=>{
 expect(()=>planIndependentGraph(branches(),basic(),'node',budget)).toThrow(FeatureResolutionError);
 const missing=branches();expect(()=>planIndependentGraph({...missing,nodes:missing.nodes.map(node=>({...node,featureId:'unknown'}))},basic(),'cloudflare',budget)).toThrow(FeatureResolutionError);
});
