import {expect,it,vi} from 'vitest';
import {FeatureRegistry} from '@edge-ffmpeg/core';
import type {CommandOperatorBinding,OperatorDescriptor} from '@edge-ffmpeg/core';
import type {R2Bucket} from '@cloudflare/workers-types';
import {buildCommandGraphMediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-command-graph.js';
function fixture(){
 const registry=new FeatureRegistry<OperatorDescriptor>();
 const kinds=['source','filter','sink'] as const;
 for(const kind of kinds)registry.register({id:kind,kind,status:'partial',runtimes:['cloudflare'],testCases:[],inputs:kind==='source'?[]:[{name:'in',type:'audio-frame'}],outputs:kind==='sink'?[]:[{name:'out',type:'audio-frame'}],traits:{state:'stateless',access:'sequential',checkpointable:false,temporal:false,deterministic:true,minimumMemoryBytes:1024,estimatedCpuTimeMs:1}});
 const nodes=['a','b'].flatMap(id=>kinds.map(kind=>({id:`${id}-${kind}`,featureId:kind}))),edges=['a','b'].flatMap(id=>[{from:{node:`${id}-source`,port:'out'},to:{node:`${id}-filter`,port:'in'},queueCapacity:1},{from:{node:`${id}-filter`,port:'out'},to:{node:`${id}-sink`,port:'in'},queueCapacity:1}]);
 const bindings=new Map<string,CommandOperatorBinding>();for(const id of ['a','b']){bindings.set(`${id}-source`,{kind:'source',path:'/input/raw',key:'source/raw',options:['-f','s16le','-ar','8000','-ac','2']});bindings.set(`${id}-filter`,{kind:'filter',mediaType:'audio',expression:'volume=0.5'});bindings.set(`${id}-sink`,{kind:'sink',path:`/output/${id}.wav`,options:['-c:a','pcm_s16le','-f','wav']});}
 const head=vi.fn(async()=>({etag:'e',version:'v',size:8}));return {options:{bucket:{head} as unknown as Pick<R2Bucket,'head'>,workflowId:'lowered',graph:{nodes,edges},registry,budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:8},bindings,implementationVersion:'test',globalArgs:['-cpuflags','0'],maxParallel:2},head};
}
it('builds independent persistent commands directly from typed operator bindings',async()=>{
 const {options,head}=fixture(),result=await buildCommandGraphMediaWorkflowSpec(options);
 expect(result.spec.nodes).toHaveLength(2);expect(head).toHaveBeenCalledTimes(1);expect(result.spec.sourceGraphHash).toMatch(/^[a-f0-9]{64}$/);
 expect(result.spec.nodes[0]!.args).toEqual(['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i','/input/raw','-af','volume=0.5','-c:a','pcm_s16le','-f','wav','/output/a.wav']);
});
it('rejects missing and extra node bindings before input metadata reads',async()=>{
 const {options,head}=fixture(),missing=new Map(options.bindings);missing.delete('a-filter');await expect(buildCommandGraphMediaWorkflowSpec({...options,bindings:missing})).rejects.toThrow(/binding/);
 const extra=new Map(options.bindings);extra.set('foreign',{kind:'sink',path:'/output/extra'});await expect(buildCommandGraphMediaWorkflowSpec({...options,bindings:extra})).rejects.toThrow(/binding/);expect(head).not.toHaveBeenCalled();
});
it('rejects graph filter overrides before provider reads',async()=>{
 const {options,head}=fixture();options.bindings.set('a-sink',{kind:'sink',path:'/output/a.wav',options:['-af','volume=0.9']});await expect(buildCommandGraphMediaWorkflowSpec(options)).rejects.toThrow();expect(head).not.toHaveBeenCalled();
});
it('captures bindings before asynchronous hashing and changes identity when lowering changes',async()=>{
 const {options}=fixture(),task=buildCommandGraphMediaWorkflowSpec(options);options.bindings.set('a-filter',{kind:'filter',mediaType:'audio',expression:'volume=0.25'});const first=await task,second=await buildCommandGraphMediaWorkflowSpec(options);expect(first.spec.nodes[0]!.args).toContain('volume=0.5');expect(second.spec.nodes[0]!.args).toContain('volume=0.25');expect(first.spec.graphHash).not.toBe(second.spec.graphHash);
});
