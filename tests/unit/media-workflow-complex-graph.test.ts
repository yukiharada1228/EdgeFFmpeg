import {expect,it,vi} from 'vitest';
import {FeatureRegistry} from '@edge-ffmpeg/core';
import type {CommandOperatorBinding,OperatorDescriptor} from '@edge-ffmpeg/core';
import type {R2Bucket} from '@cloudflare/workers-types';
import {buildComplexVideoGraphMediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-command-graph.js';
function fixture(){
 const registry=new FeatureRegistry<OperatorDescriptor>(),port=(name:string)=>({name,type:'video-frame' as const});
 const definitions=[{id:'source',kind:'source',inputs:[],outputs:[port('out')]},{id:'split',kind:'filter',inputs:[port('in')],outputs:[port('left'),port('right')]},{id:'left',kind:'filter',inputs:[port('in')],outputs:[port('out')]},{id:'right',kind:'filter',inputs:[port('in')],outputs:[port('out')]},{id:'join',kind:'filter',inputs:[port('left'),port('right')],outputs:[port('out')]},{id:'sink',kind:'sink',inputs:[port('in')],outputs:[]}] as const;
 for(const descriptor of definitions)registry.register({...descriptor,status:'partial',runtimes:['cloudflare'],testCases:[],traits:{state:'stateless',access:'sequential',checkpointable:false,temporal:false,deterministic:true,minimumMemoryBytes:1024,estimatedCpuTimeMs:1}});
 const edge=(from:string,fromPort:string,to:string,toPort:string)=>({from:{node:from,port:fromPort},to:{node:to,port:toPort},queueCapacity:1});
 const graph={nodes:definitions.map(node=>({id:node.id,featureId:node.id})),edges:[edge('source','out','split','in'),edge('split','left','left','in'),edge('split','right','right','in'),edge('left','out','join','left'),edge('right','out','join','right'),edge('join','out','sink','in')]};
 const bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/input/video',key:'source/video',options:['-f','rawvideo','-pixel_format','gray','-video_size','2x2']}],['split',{kind:'filter',mediaType:'video',expression:'split=2'}],['left',{kind:'filter',mediaType:'video',expression:'hflip'}],['right',{kind:'filter',mediaType:'video',expression:'null'}],['join',{kind:'filter',mediaType:'video',expression:'hstack=inputs=2'}],['sink',{kind:'sink',path:'/output/video',options:['-c:v','rawvideo','-f','rawvideo']}]]);
 const head=vi.fn(async()=>({etag:'e',version:'v',size:8}));return {options:{graph,registry,bindings,bucket:{head} as unknown as Pick<R2Bucket,'head'>,budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:10000,maxPendingPackets:16},workflowId:'complex',implementationVersion:'test',globalArgs:['-cpuflags','0']},head};
}
it('builds a complete split and join Workflow command without application argv lowering',async()=>{
 const {options,head}=fixture(),result=await buildComplexVideoGraphMediaWorkflowSpec(options);expect(result.spec.nodes).toHaveLength(1);expect(head).toHaveBeenCalledTimes(1);const args=result.spec.nodes[0]!.args;expect(args).toContain('-filter_complex');expect(args).toContain('-map');expect(args[args.indexOf('-filter_complex')+1]).toContain('hstack=inputs=2');expect(result.spec.sourceGraphHash).toMatch(/^[a-f0-9]{64}$/);
});
it('keeps graph provenance and generated CLI stable under declaration reorder',async()=>{
 const {options}=fixture(),first=await buildComplexVideoGraphMediaWorkflowSpec(options),second=await buildComplexVideoGraphMediaWorkflowSpec({...options,graph:{nodes:[...options.graph.nodes].reverse(),edges:[...options.graph.edges].reverse()}});expect(second.spec.graphHash).toBe(first.spec.graphHash);expect(second.spec.nodes[0]!.args).toEqual(first.spec.nodes[0]!.args);
});
it('rejects unsupported audio bindings before object metadata reads',async()=>{
 const {options,head}=fixture();options.bindings.set('left',{kind:'filter',mediaType:'audio',expression:'volume=0.5'});await expect(buildComplexVideoGraphMediaWorkflowSpec(options)).rejects.toThrow();expect(head).not.toHaveBeenCalled();
});
it('captures all graph bindings before asynchronous input pinning',async()=>{
 const {options}=fixture(),pending=buildComplexVideoGraphMediaWorkflowSpec(options);options.bindings.set('left',{kind:'filter',mediaType:'video',expression:'vflip'});const first=await pending,second=await buildComplexVideoGraphMediaWorkflowSpec(options);expect(first.spec.nodes[0]!.args.join(' ')).toContain('hflip');expect(second.spec.graphHash).not.toBe(first.spec.graphHash);
});
