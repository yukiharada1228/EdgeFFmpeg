import {expect,it,vi} from 'vitest';
import {FeatureRegistry} from '@edge-ffmpeg/core';
import type {ExecutionGraph,OperatorDescriptor} from '@edge-ffmpeg/core';
import type {R2Bucket} from '@cloudflare/workers-types';
import {buildIndependentMediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-graph.js';
import {readyMediaWorkflowNodes} from '../../packages/runtime-cloudflare/src/jobs/workflow-plan.js';
const budget={maxResidentBytes:30,maxBufferBytes:10,maxCpuTimeMs:1000,maxPendingPackets:1};
function fixture(){
 const registry=new FeatureRegistry<OperatorDescriptor>();
 for(const kind of ['source','sink'] as const)registry.register({id:kind,kind,status:'partial',runtimes:['cloudflare'],testCases:[],inputs:kind==='source'?[]:[{name:'in',type:'packet'}],outputs:kind==='sink'?[]:[{name:'out',type:'packet'}],traits:{state:kind==='source'?'stateless':'stateful',access:'sequential',checkpointable:false,temporal:kind==='sink',deterministic:true,minimumMemoryBytes:10,estimatedCpuTimeMs:10}});
 const nodes=['a','b'].flatMap(id=>[{id:id+'-in',featureId:'source'},{id:id+'-out',featureId:'sink'}]);
 const edges=['a','b'].map(id=>({from:{node:id+'-in',port:'out'},to:{node:id+'-out',port:'in'},queueCapacity:1}));
 const graph:ExecutionGraph={nodes,edges};const head=vi.fn(async()=>({etag:'etag',version:'version',size:8}));
 const commandForWorkUnit=vi.fn(()=>({args:['-i','/in','/out'],inputs:[{path:'/in',source:{kind:'object' as const,key:'source/shared'}}],outputs:[{path:'/out'}],implementationVersion:'test'}));
 return {options:{workflowId:'independent',graph,registry,budget,bucket:{head} as unknown as Pick<R2Bucket,'head'>,commandForWorkUnit,maxParallel:2},head,commandForWorkUnit};
}
it('lowers automatically discovered independent components into ready bounded Workflow commands',async()=>{
 const {options,head,commandForWorkUnit}=fixture(),result=await buildIndependentMediaWorkflowSpec(options);
 expect(result.plan.workUnits).toHaveLength(2);expect(result.plan.aggregate.minimumMemoryBytes).toBe(40);expect(commandForWorkUnit).toHaveBeenCalledTimes(2);expect(head).toHaveBeenCalledTimes(1);
 expect(result.spec.nodes.map(node=>node.id)).toEqual(['unit-0','unit-1']);expect(result.spec.nodes.every(node=>node.budget.maxResidentBytes===30)).toBe(true);
 expect(readyMediaWorkflowNodes(result.spec,new Set(),new Set()).map(node=>node.id)).toEqual(['unit-0','unit-1']);expect(Object.isFrozen(result.workUnits[0])).toBe(true);
 const reversed=await buildIndependentMediaWorkflowSpec({...options,graph:{nodes:[...options.graph.nodes].reverse(),edges:[...options.graph.edges].reverse()}});
 expect(reversed.workUnits).toEqual(result.workUnits);expect(reversed.spec.graphHash).toBe(result.spec.graphHash);
});
it('rejects an indivisible connected path that exceeds its Worker budget before object pinning',async()=>{
 const {options,head,commandForWorkUnit}=fixture();await expect(buildIndependentMediaWorkflowSpec({...options,budget:{...budget,maxResidentBytes:15}})).rejects.toThrow(/memory/i);expect(head).not.toHaveBeenCalled();expect(commandForWorkUnit).not.toHaveBeenCalled();
});
it('rejects component command dependencies rather than silently adding cross-partition edges',async()=>{
 const {options,head}=fixture();const command=options.commandForWorkUnit();
 await expect(buildIndependentMediaWorkflowSpec({...options,commandForWorkUnit:()=>({...command,inputs:[{path:'/in',source:{kind:'artifact',nodeId:'unit-0',path:'/out'}}]}) as unknown as ReturnType<typeof options.commandForWorkUnit>})).rejects.toThrow(/external object/);expect(head).not.toHaveBeenCalled();
});
it('rejects more components than the Workflow bound before lowering or provider reads',async()=>{
 const {options,head,commandForWorkUnit}=fixture();const nodes=Array.from({length:17},(_,i)=>[{id:`${i}-in`,featureId:'source'},{id:`${i}-out`,featureId:'sink'}]).flat(),edges=Array.from({length:17},(_,i)=>({from:{node:`${i}-in`,port:'out'},to:{node:`${i}-out`,port:'in'},queueCapacity:1}));
 await expect(buildIndependentMediaWorkflowSpec({...options,graph:{nodes,edges}})).rejects.toThrow(/16 command/);expect(head).not.toHaveBeenCalled();expect(commandForWorkUnit).not.toHaveBeenCalled();
});
it('binds source graph membership into workflow identity even when lowered commands are identical',async()=>{
 const {options}=fixture(),first=await buildIndependentMediaWorkflowSpec(options);
 const renamed={nodes:options.graph.nodes.map(node=>({...node,id:'renamed-'+node.id})),edges:options.graph.edges.map(edge=>({...edge,from:{...edge.from,node:'renamed-'+edge.from.node},to:{...edge.to,node:'renamed-'+edge.to.node}}))};
 const second=await buildIndependentMediaWorkflowSpec({...options,graph:renamed});expect(second.spec.sourceGraphHash).toMatch(/^[a-f0-9]{64}$/);expect(second.spec.sourceGraphHash).not.toBe(first.spec.sourceGraphHash);expect(second.spec.graphHash).not.toBe(first.spec.graphHash);
});
it('captures command results and scheduling before asynchronous graph hashing or input pinning',async()=>{
 const {options}=fixture(),command=options.commandForWorkUnit(),mutable={...options,commandForWorkUnit:()=>command};
 const task=buildIndependentMediaWorkflowSpec(mutable);command.args[0]='mutated';mutable.workflowId='changed';mutable.maxParallel=1;
 const result=await task;expect(result.spec.workflowId).toBe('independent');expect(result.spec.maxParallel).toBe(2);expect(result.spec.nodes[0]!.args[0]).toBe('-i');
});
