import {expect,it} from 'vitest';
import {parseArgv} from '@edge-ffmpeg/cli';
import {parseFilterTopology} from '@edge-ffmpeg/avfilter';
import type {FilterToken} from '@edge-ffmpeg/avfilter';
import {FeatureRegistry,PlanningError,planIndependentGraph} from '@edge-ffmpeg/core';
import type {ExecutionGraph,MediaPortType,OperatorDescriptor,ResourceBudget} from '@edge-ffmpeg/core';
import type {CommandOperatorBinding} from '../../packages/core/src/command-graph.js';
import {lowerComplexVideoCommand} from '../../packages/core/src/complex-command-graph.js';
const budget:ResourceBudget={maxResidentBytes:4096,maxBufferBytes:64,maxCpuTimeMs:1000,maxPendingPackets:64};
const port=(name:string,type:MediaPortType='video-frame',optional?:boolean)=>({name,type,...(optional===undefined?{}:{optional})});
function operator(id:string,kind:OperatorDescriptor['kind'],inputs:OperatorDescriptor['inputs'],outputs:OperatorDescriptor['outputs']):OperatorDescriptor{return {id,kind,inputs,outputs,status:'partial',runtimes:['cloudflare'],testCases:[],traits:{state:'stateless',access:'sequential',checkpointable:false,temporal:false,deterministic:true,minimumMemoryBytes:8,estimatedCpuTimeMs:1}};}
const edge=(from:string,fromPort:string,to:string,toPort:string)=>({from:{node:from,port:fromPort},to:{node:to,port:toPort},queueCapacity:1});
function plan(operators:OperatorDescriptor[],edges:ExecutionGraph['edges']){const registry=new FeatureRegistry<OperatorDescriptor>();for(const descriptor of operators)registry.register(descriptor);return planIndependentGraph({nodes:operators.map(descriptor=>({id:descriptor.id,featureId:descriptor.id})).reverse(),edges:[...edges].reverse()},registry,'cloudflare',budget).workUnits[0]!;}
function stack(inputOrder:readonly string[]=['left','right']){
 const operators=[operator('z-source','source',[],[port('out','packet')]),operator('a-source','source',[],[port('out','packet')]),operator('a-decode','decode',[port('in','packet')],[port('out')]),operator('z-decode','decode',[port('in','packet')],[port('out')]),operator('stack','filter',inputOrder.map(name=>port(name)),[port('out')]),operator('encode','encode',[port('in')],[port('out','packet')]),operator('mux','mux',[port('in','packet')],[port('out','packet')]),operator('sink','sink',[port('in','packet')],[])];
 const edges=[edge('a-source','out','a-decode','in'),edge('z-source','out','z-decode','in'),edge('z-decode','out','stack','right'),edge('a-decode','out','stack','left'),edge('stack','out','encode','in'),edge('encode','out','mux','in'),edge('mux','out','sink','in')];
 const bindings=new Map<string,CommandOperatorBinding>([['a-source',{kind:'source',path:'/input/a.bmp',key:'images/a.bmp',options:['-f','bmp']}],['z-source',{kind:'source',path:'/input/z.bmp',key:'images/z.bmp',options:['-f','bmp','-ss','0']}],['a-decode',{kind:'input-options',options:['-c:v','bmp']}],['z-decode',{kind:'input-options',options:['-c:v','bmp']}],['stack',{kind:'filter',mediaType:'video',expression:'hstack=inputs=2'}],['encode',{kind:'output-options',options:['-c:v','rawvideo']}],['mux',{kind:'output-options',options:['-f','rawvideo']}],['sink',{kind:'sink',path:'/output/stack.rgb',options:['-pix_fmt','rgb24','-frames:v','1'] }]]);
 return {work:plan(operators,edges),operators,edges,bindings};
}
function split(){
 const operators=[operator('source','source',[],[port('out')]),operator('split','filter',[port('in')],[port('first'),port('second')]),operator('a-sink','sink',[port('in')],[]),operator('z-sink','sink',[port('in')],[])],edges=[edge('source','out','split','in'),edge('split','second','a-sink','in'),edge('split','first','z-sink','in')];
 const bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/input/raw.rgb',key:'source/raw.rgb',options:['-f','rawvideo','-pixel_format','rgb24','-video_size','1x1']}],['split',{kind:'filter',mediaType:'video',expression:'split=2'}],['a-sink',{kind:'sink',path:'/output/a.rgb',options:['-f','rawvideo','-frames:v','1']}],['z-sink',{kind:'sink',path:'/output/z.rgb',options:['-f','rawvideo','-frames:v','1']}]]);return {work:plan(operators,edges),operators,edges,bindings};
}
function topology(args:readonly string[]){const parsed=parseArgv(args),description=parsed.global.find(option=>option.name==='-filter_complex')?.value;expect(description).toBeTypeOf('string');const result=parseFilterTopology(description!,(token:FilterToken)=>({inputs:token.name==='hstack'?2:1,outputs:token.name==='split'?2:1,configuration:null}));return {parsed,description:description!,topology:result};}
const videoIndex=(label:string)=>{const match=/^(\d+):v(?::0)?$/.exec(label);expect(match,label).not.toBeNull();return Number(match![1]);};
it.each([['left','right'],['right','left']])('uses declared hstack input pad order rather than edge/source order: %j',(first,second)=>{
 const run=stack([first,second]),lowered=lowerComplexVideoCommand(run.work,run.bindings,{globalArgs:['-cpuflags','0','-y']}),result=topology(lowered.args),stackNode=result.topology.nodes.find(node=>node.name==='hstack')!;
 expect(lowered.inputs).toEqual([{path:'/input/a.bmp',key:'images/a.bmp'},{path:'/input/z.bmp',key:'images/z.bmp'}]);expect(result.parsed.inputs.map(input=>input.url)).toEqual(['/input/a.bmp','/input/z.bmp']);expect(stackNode.inputLabels.map(videoIndex)).toEqual(first==='left'?[0,1]:[1,0]);
 expect(result.parsed.inputs[0]!.options).toEqual([{name:'-f',value:'bmp'},{name:'-c:v',value:'bmp'}]);expect(result.parsed.inputs[1]!.options).toEqual([{name:'-f',value:'bmp'},{name:'-ss',value:'0'},{name:'-c:v',value:'bmp'}]);
 expect(result.parsed.outputs).toHaveLength(1);expect(result.parsed.outputs[0]!.options.find(option=>option.name==='-map')?.value).toBe(`[${stackNode.outputLabels[0]}]`);expect(result.parsed.outputs[0]!.options.map(option=>option.name)).toEqual(['-map','-c:v','-f','-pix_fmt','-frames:v']);
});
it('preserves declared split output order while independently mapping sorted output files',()=>{
 const run=split(),lowered=lowerComplexVideoCommand(run.work,run.bindings),result=topology(lowered.args),fork=result.topology.nodes.find(node=>node.name==='split')!;
 expect(lowered.outputs).toEqual([{path:'/output/a.rgb'},{path:'/output/z.rgb'}]);expect(result.parsed.outputs.map(output=>output.options.find(option=>option.name==='-map')?.value)).toEqual([`[${fork.outputLabels[1]}]`,`[${fork.outputLabels[0]}]`]);expect(new Set(fork.outputLabels).size).toBe(2);expect(result.topology.outputs).toHaveLength(2);
});
it('retains every branch and join in a split-transform-stack filter DAG',()=>{
 const operators=[operator('source','source',[],[port('out')]),operator('split','filter',[port('in')],[port('first'),port('second')]),operator('z-flip','filter',[port('in')],[port('out')]),operator('a-pass','filter',[port('in')],[port('out')]),operator('stack','filter',[port('left'),port('right')],[port('out')]),operator('sink','sink',[port('in')],[])];
 const edges=[edge('source','out','split','in'),edge('split','first','z-flip','in'),edge('split','second','a-pass','in'),edge('z-flip','out','stack','left'),edge('a-pass','out','stack','right'),edge('stack','out','sink','in')];
 const bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/in.rgb',key:'source.rgb'}],['split',{kind:'filter',mediaType:'video',expression:'split=2'}],['z-flip',{kind:'filter',mediaType:'video',expression:'hflip'}],['a-pass',{kind:'filter',mediaType:'video',expression:'null'}],['stack',{kind:'filter',mediaType:'video',expression:'hstack=inputs=2'}],['sink',{kind:'sink',path:'/out.rgb',options:['-f','rawvideo']}]]);
 const result=topology(lowerComplexVideoCommand(plan(operators,edges),bindings).args),fork=result.topology.nodes.find(node=>node.name==='split')!,flip=result.topology.nodes.find(node=>node.name==='hflip')!,pass=result.topology.nodes.find(node=>node.name==='null')!,join=result.topology.nodes.find(node=>node.name==='hstack')!;
 expect(result.topology.nodes).toHaveLength(4);expect(flip.inputLabels).toEqual([fork.outputLabels[0]]);expect(pass.inputLabels).toEqual([fork.outputLabels[1]]);expect(join.inputLabels).toEqual([flip.outputLabels[0],pass.outputLabels[0]]);expect(result.parsed.outputs[0]!.options.find(option=>option.name==='-map')?.value).toBe(`[${join.outputLabels[0]}]`);
});
it('keeps encoder and mux options within each corresponding output suffix',()=>{
 const run=split(),operators=run.operators.filter(node=>node.kind!=='sink');
 for(const side of ['a','z'])operators.push(operator(`${side}-encode`,'encode',[port('in')],[port('out','packet')]),operator(`${side}-mux`,'mux',[port('in','packet')],[port('out','packet')]),operator(`${side}-sink`,'sink',[port('in','packet')],[]));
 const edges=[edge('source','out','split','in'),...['a','z'].flatMap(side=>[edge('split',side==='a'?'second':'first',`${side}-encode`,'in'),edge(`${side}-encode`,'out',`${side}-mux`,'in'),edge(`${side}-mux`,'out',`${side}-sink`,'in')])];
 for(const side of ['a','z']){run.bindings.set(`${side}-encode`,{kind:'output-options',options:['-c:v','rawvideo','-pix_fmt',side==='a'?'rgb24':'bgr24']});run.bindings.set(`${side}-mux`,{kind:'output-options',options:['-f','rawvideo']});run.bindings.set(`${side}-sink`,{kind:'sink',path:`/output/${side}.rgb`,options:['-frames:v',side==='a'?'1':'2']});}
 const result=parseArgv(lowerComplexVideoCommand(plan(operators,edges),run.bindings).args);expect(result.outputs.map(output=>output.options.find(option=>option.name==='-pix_fmt')?.value)).toEqual(['rgb24','bgr24']);expect(result.outputs.map(output=>output.options.find(option=>option.name==='-frames:v')?.value)).toEqual(['1','2']);expect(result.inputs[0]!.options.some(option=>option.name==='-c:v')).toBe(false);
});
it('canonicalizes generated labels, bindings and file order under node/edge/map permutations',()=>{
 const run=stack(),first=lowerComplexVideoCommand(run.work,run.bindings),second=lowerComplexVideoCommand({...run.work,graph:{...run.work.graph,nodes:[...run.work.graph.nodes].reverse(),edges:[...run.work.graph.edges].reverse()}},new Map([...run.bindings].reverse()));expect(second).toEqual(first);
});
it('snapshots mutable options and freezes returned arguments and file descriptors',()=>{
 const run=split(),options=['-f','rawvideo'],globals=['-cpuflags','0'];run.bindings.set('a-sink',{kind:'sink',path:'/output/a.rgb',options});const result=lowerComplexVideoCommand(run.work,run.bindings,{globalArgs:globals}),before=JSON.stringify(result);options.push('/injected');globals[1]='changed';run.bindings.clear();expect(JSON.stringify(result)).toBe(before);for(const value of [result,result.args,result.inputs,result.outputs,...result.inputs,...result.outputs])expect(Object.isFrozen(value)).toBe(true);
});
it.each(['missing','extra','wrong-kind','audio','labels','semicolon','multipad-comma'] as const)('rejects invalid complex video binding metadata: %s',variant=>{
 const run=stack();if(variant==='missing')run.bindings.delete('a-decode');else if(variant==='extra')run.bindings.set('hidden',{kind:'input-options',options:[]});else if(variant==='wrong-kind')run.bindings.set('stack',{kind:'output-options',options:[]});else run.bindings.set('stack',{kind:'filter',mediaType:variant==='audio'?'audio':'video',expression:variant==='labels'?'[in]hstack[out]':variant==='semicolon'?'hstack;hflip':variant==='multipad-comma'?'hstack,hflip':'hstack=inputs=2'});expect(()=>lowerComplexVideoCommand(run.work,run.bindings)).toThrow(PlanningError);
});
it('rejects audio frame ports even when the filter binding claims video',()=>{
 const run=stack(),work={...run.work,graph:{...run.work.graph,nodes:run.work.graph.nodes.map(node=>node.id==='stack'?{...node,operator:{...node.operator,inputs:node.operator.inputs.map(input=>({...input,type:'audio-frame' as const}))}}:node)}};expect(()=>lowerComplexVideoCommand(work,run.bindings)).toThrow(PlanningError);
});
it.each([['a-source',['-i','/other']],['a-decode',['-y']],['sink',['-i','/other']],['sink',['/other']],['encode',['-map','0:v']],['mux',['-vf','hflip']]] as const)('rejects scope escape or generated-graph overrides in %s',(id,options)=>{
 const run=stack(),binding=run.bindings.get(id)!;if(binding.kind==='filter')throw Error('Fixture requires option binding');run.bindings.set(id,{...binding,options:[...options]});expect(()=>lowerComplexVideoCommand(run.work,run.bindings)).toThrow(PlanningError);
});
it.each([['-filter_complex','null'],['-lavfi','null'],['-f','rawvideo'],['-i','/extra']])('rejects graph-overriding or input-scoped global arguments: %j',(...globalArgs)=>{const run=stack();expect(()=>lowerComplexVideoCommand(run.work,run.bindings,{globalArgs})).toThrow(PlanningError);});
it.each(['input-input','input-output','output-output'] as const)('rejects colliding virtual file identities: %s',variant=>{
 const run=variant==='output-output'?split():stack();if(variant==='input-input')run.bindings.set('z-source',{kind:'source',path:'/input/a.bmp',key:'images/z.bmp'});else if(variant==='input-output')run.bindings.set('sink',{kind:'sink',path:'/input/a.bmp'});else run.bindings.set('z-sink',{kind:'sink',path:'/output/a.rgb'});expect(()=>lowerComplexVideoCommand(run.work,run.bindings)).toThrow(PlanningError);
});
it('rejects optional declared filter pads that have no explicit graph edge',()=>{
 const run=stack(),operators=run.operators.map(descriptor=>descriptor.id==='stack'?{...descriptor,inputs:[...descriptor.inputs,port('unconnected','video-frame',true)]}:descriptor);expect(()=>lowerComplexVideoCommand(plan(operators,run.edges),run.bindings)).toThrow(PlanningError);
});
it('rejects a source prefix shared by two decoded paths instead of silently duplicating execution',()=>{
 const operators=[operator('source','source',[],[port('a','packet'),port('b','packet')]),operator('decode-a','decode',[port('in','packet')],[port('out')]),operator('decode-b','decode',[port('in','packet')],[port('out')]),operator('stack','filter',[port('a'),port('b')],[port('out')]),operator('sink','sink',[port('in')],[])],edges=[edge('source','a','decode-a','in'),edge('source','b','decode-b','in'),edge('decode-a','out','stack','a'),edge('decode-b','out','stack','b'),edge('stack','out','sink','in')];
 const bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/in',key:'in'}],['decode-a',{kind:'input-options',options:[]}],['decode-b',{kind:'input-options',options:[]}],['stack',{kind:'filter',mediaType:'video',expression:'hstack=2'}],['sink',{kind:'sink',path:'/out'}]]);expect(()=>lowerComplexVideoCommand(plan(operators,edges),bindings)).toThrow(PlanningError);
});
it('rejects two filter outputs joining inside an encoder suffix',()=>{
 const operators=[operator('source','source',[],[port('out')]),operator('split','filter',[port('in')],[port('a'),port('b')]),operator('encode','encode',[port('a'),port('b')],[port('out','packet')]),operator('sink','sink',[port('in','packet')],[])],edges=[edge('source','out','split','in'),edge('split','a','encode','a'),edge('split','b','encode','b'),edge('encode','out','sink','in')],bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/in',key:'in'}],['split',{kind:'filter',mediaType:'video',expression:'split=2'}],['encode',{kind:'output-options',options:[]}],['sink',{kind:'sink',path:'/out'}]]);expect(()=>lowerComplexVideoCommand(plan(operators,edges),bindings)).toThrow(PlanningError);
});
it('rejects hidden untraversed nodes rather than silently discarding registered work',()=>{
 const run=stack(),hidden={id:'hidden',featureId:'hidden',operator:operator('hidden','filter',[port('in')],[port('out')])},work={...run.work,nodeIds:[...run.work.nodeIds,'hidden'],graph:{...run.work.graph,nodes:[...run.work.graph.nodes,hidden]}};run.bindings.set('hidden',{kind:'filter',mediaType:'video',expression:'hflip'});expect(()=>lowerComplexVideoCommand(work,run.bindings)).toThrow(PlanningError);
});
it('bounds individual option fragments and rejects sparse arrays with planning errors',()=>{
 const run=stack();run.bindings.set('a-source',{kind:'source',path:'/in',key:'in',options:Array.from({length:1026},(_,index)=>index%2? 'bmp':'-f')});expect(()=>lowerComplexVideoCommand(run.work,run.bindings)).toThrow(PlanningError);
 run.bindings.set('a-source',{kind:'source',path:'/in',key:'in',options:new Array<string>(2)});expect(()=>lowerComplexVideoCommand(run.work,run.bindings)).toThrow(PlanningError);
});
