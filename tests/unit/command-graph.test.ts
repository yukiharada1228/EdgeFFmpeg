import {expect,it} from 'vitest';
import {parseArgv} from '@edge-ffmpeg/cli';
import {FeatureRegistry,PlanningError,planIndependentGraph} from '@edge-ffmpeg/core';
import type {ExecutionGraph,MediaPortType,OperatorDescriptor,ResourceBudget} from '@edge-ffmpeg/core';
import {lowerIndependentCommand} from '../../packages/core/src/command-graph.js';
import type {CommandOperatorBinding} from '../../packages/core/src/command-graph.js';
const budget:ResourceBudget={maxResidentBytes:1024,maxBufferBytes:64,maxCpuTimeMs:1000,maxPendingPackets:32};
function descriptor(id:string,kind:OperatorDescriptor['kind'],input:MediaPortType='packet',output:MediaPortType=input):OperatorDescriptor{return {id,kind,status:'partial',runtimes:['cloudflare'],testCases:[],inputs:kind==='source'?[]:[{name:'in',type:input}],outputs:kind==='sink'?[]:[{name:'out',type:output}],traits:{state:kind==='filter'?'stateful':'stateless',access:'sequential',checkpointable:false,temporal:kind==='filter',deterministic:true,minimumMemoryBytes:8,estimatedCpuTimeMs:10}};}
function unit(operators:OperatorDescriptor[]){const registry=new FeatureRegistry<OperatorDescriptor>();for(const operator of operators)registry.register(operator);const graph:ExecutionGraph={nodes:operators.map(operator=>({id:operator.id,featureId:operator.id})).reverse(),edges:operators.slice(1).map((operator,index)=>({from:{node:operators[index]!.id,port:'out'},to:{node:operator.id,port:'in'},queueCapacity:1}))};return planIndependentGraph(graph,registry,'cloudflare',budget).workUnits[0]!;}
function fixture(media:'audio'|'video'='audio'){
 const frame:MediaPortType=media==='audio'?'audio-frame':'video-frame';
 const work=unit([descriptor('source','source'),descriptor('demux','demux'),descriptor('decode','decode','packet',frame),descriptor('first','filter',frame),descriptor('second','filter',frame),descriptor('encode','encode',frame,'packet'),descriptor('mux','mux'),descriptor('sink','sink')]);
 const bindings=new Map<string,CommandOperatorBinding>([
  ['source',{kind:'source',path:'/input/source.flac',key:'source/data.flac',options:['-f','flac','-ss','0']}],
  ['demux',{kind:'input-options',options:['-fflags','+bitexact']}],['decode',{kind:'input-options',options:['-c:a','flac']}],
  ['first',{kind:'filter',mediaType:media,expression:media==='audio'?'volume=0.5:precision=fixed':'transpose=clock'}],
  ['second',{kind:'filter',mediaType:media,expression:media==='audio'?'aformat=sample_fmts=s16':'format=pix_fmts=yuv420p'}],
  ['encode',{kind:'output-options',options:['-c:a','pcm_s16le']}],['mux',{kind:'output-options',options:['-f','wav']}],
  ['sink',{kind:'sink',path:'/output/result.wav',options:['-ss','0.005','-t','0.01','-map_metadata','-1']}],
 ]);return {work,bindings};
}
it('lowers one whole linear component into correctly scoped CLI options and ordered filters',()=>{
 const run=fixture(),lowered=lowerIndependentCommand(run.work,run.bindings,{globalArgs:['-cpuflags','0','-y','-hide_banner']});
 expect(lowered.inputs).toEqual([{path:'/input/source.flac',key:'source/data.flac'}]);expect(lowered.outputs).toEqual([{path:'/output/result.wav'}]);
 expect(lowered.args).toEqual(['-cpuflags','0','-y','-hide_banner','-f','flac','-ss','0','-fflags','+bitexact','-c:a','flac','-i','/input/source.flac','-af','volume=0.5:precision=fixed,aformat=sample_fmts=s16','-c:a','pcm_s16le','-f','wav','-ss','0.005','-t','0.01','-map_metadata','-1','/output/result.wav']);
 const parsed=parseArgv(lowered.args);expect(parsed.inputs).toHaveLength(1);expect(parsed.outputs).toHaveLength(1);expect(parsed.global.map(option=>option.name)).toEqual(['-cpuflags','-y','-hide_banner']);expect(parsed.inputs[0]!.options.map(option=>option.name)).toEqual(['-f','-ss','-fflags','-c:a']);expect(parsed.outputs[0]!.options.find(option=>option.name==='-af')?.value).toBe('volume=0.5:precision=fixed,aformat=sample_fmts=s16');
});
it('emits a video filter chain without audio-filter scope',()=>{
 const run=fixture('video'),parsed=parseArgv(lowerIndependentCommand(run.work,run.bindings).args);expect(parsed.outputs[0]!.options.find(option=>option.name==='-vf')?.value).toBe('transpose=clock,format=pix_fmts=yuv420p');expect(parsed.outputs[0]!.options.some(option=>option.name==='-af')).toBe(false);
});
it('preserves compatibility-affecting options and explicit zero output frame limits',()=>{
 const run=fixture();run.bindings.set('sink',{kind:'sink',path:'/output/result.wav',options:['-frames:a','0','-bitexact','-map_metadata','-1']});
 const parsed=parseArgv(lowerIndependentCommand(run.work,run.bindings,{globalArgs:['-copyts','-start_at_zero','-cpuflags','0']}).args);expect(parsed.global.map(option=>option.name)).toEqual(['-copyts','-start_at_zero','-cpuflags']);expect(parsed.outputs[0]!.options).toContainEqual({name:'-frames:a',value:'0'});expect(parsed.outputs[0]!.options).toContainEqual({name:'-bitexact',value:null});
});
it('supports a direct source-to-sink copy command without inventing a filter stage',()=>{
 const work=unit([descriptor('source','source'),descriptor('sink','sink')]),bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/in.flac',key:'source.flac'}],['sink',{kind:'sink',path:'/out.flac',options:['-c:a','copy','-f','flac']}]]);
 const parsed=parseArgv(lowerIndependentCommand(work,bindings).args);expect(parsed.inputs[0]!.url).toBe('/in.flac');expect(parsed.outputs[0]!.options).toEqual([{name:'-c:a',value:'copy'},{name:'-f',value:'flac'}]);
});
it('does not alias Unicode or prototype-like binding IDs',()=>{
 const registry=new FeatureRegistry<OperatorDescriptor>();registry.register(descriptor('source','source'));registry.register(descriptor('sink','sink'));const work=planIndependentGraph({nodes:[{id:'__proto__',featureId:'source'},{id:'音声😀',featureId:'sink'}],edges:[{from:{node:'__proto__',port:'out'},to:{node:'音声😀',port:'in'},queueCapacity:1}]},registry,'cloudflare',budget).workUnits[0]!;
 const lowered=lowerIndependentCommand(work,new Map([['__proto__',{kind:'source' as const,path:'/入力/音声.flac',key:'source/音声.flac'}],['音声😀',{kind:'sink' as const,path:'/出力/結果.flac'}]]));expect(lowered.inputs[0]!.path).toBe('/入力/音声.flac');expect(lowered.outputs[0]!.path).toBe('/出力/結果.flac');
});
it('snapshots mutable binding values/options and freezes every returned descriptor',()=>{
 const run=fixture(),sourceOptions=['-f','flac'],globals=['-cpuflags','0'];run.bindings.set('source',{kind:'source',path:'/in.flac',key:'source.flac',options:sourceOptions});const result=lowerIndependentCommand(run.work,run.bindings,{globalArgs:globals}),before=JSON.stringify(result);
 sourceOptions[1]='changed';globals[1]='changed';run.bindings.clear();expect(JSON.stringify(result)).toBe(before);for(const value of [result,result.args,result.inputs,result.outputs,result.inputs[0],result.outputs[0]])expect(Object.isFrozen(value)).toBe(true);expect(Object.isFrozen(sourceOptions)).toBe(false);
});
it.each(['missing','extra','wrong-source','wrong-filter','wrong-decode','wrong-sink'] as const)('rejects incomplete or incorrectly scoped binding metadata: %s',variant=>{
 const run=fixture();if(variant==='missing')run.bindings.delete('decode');else if(variant==='extra')run.bindings.set('unknown',{kind:'input-options',options:[]});else if(variant==='wrong-source')run.bindings.set('source',{kind:'input-options',options:[]});else if(variant==='wrong-filter')run.bindings.set('first',{kind:'output-options',options:[]});else if(variant==='wrong-decode')run.bindings.set('decode',{kind:'output-options',options:[]});else run.bindings.set('sink',{kind:'source',path:'/out',key:'out'});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow();
});
it.each([['source',['-i','/other']],['decode',['/extra']],['sink',['/extra']],['encode',['-y']],['demux',['-cpuflags','0']],['mux',['-i','/other']]] as const)('rejects file/option scope escapes in %s', (node,options)=>{
 const run=fixture(),binding=run.bindings.get(node)!;if(binding.kind==='filter')throw Error('Fixture requires an option binding');run.bindings.set(node,{...binding,options:[...options]});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow();
});
it.each([['-i','/other'],['-f','flac'],['/extra'],['-filter_complex','anull'],['-lavfi','anull']])('rejects non-global or graph-overriding global arguments: %j',(...args)=>{
 const run=fixture();expect(()=>lowerIndependentCommand(run.work,run.bindings,{globalArgs:args})).toThrow();
});
it.each([['-af','anull'],['-vf','hflip'],['-filter:a','anull'],['-map','0:a'],['-filter_complex','anull']])('rejects raw options overriding graph wiring: %j',(...options)=>{
 const run=fixture();run.bindings.set('encode',{kind:'output-options',options});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow();
});
it.each(['','anull;anull','[in]anull[out]','anull\0'])('rejects non-linear or malformed filter descriptions: %s',expression=>{
 const run=fixture();run.bindings.set('first',{kind:'filter',mediaType:'audio',expression});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow();
});
it('rejects a filter binding whose media type disagrees with its actual frame ports',()=>{
 const run=fixture();run.bindings.set('first',{kind:'filter',mediaType:'video',expression:'hflip'});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow();
});
it.each(['/relative/../input','relative.flac','/input/./file','/input//file','/input\0file'])('rejects noncanonical source paths: %s',path=>{
 const run=fixture();run.bindings.set('source',{kind:'source',path,key:'source'});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow();
});
it.each(['/absolute','../escape','a/../escape','a//b','a\0b'])('rejects invalid R2 source keys: %s',key=>{
 const run=fixture();run.bindings.set('source',{kind:'source',path:'/in',key});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow();
});
it('rejects an output aliasing the declared input path',()=>{const run=fixture();run.bindings.set('sink',{kind:'sink',path:'/input/source.flac'});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow();});
it('rejects connected fanout instead of manufacturing independent CLI invocations',()=>{
 const registry=new FeatureRegistry<OperatorDescriptor>();registry.register({...descriptor('source','source'),outputs:[{name:'left',type:'packet'},{name:'right',type:'packet'}]});registry.register(descriptor('sink','sink'));
 const work=planIndependentGraph({nodes:[{id:'source',featureId:'source'},{id:'left',featureId:'sink'},{id:'right',featureId:'sink'}],edges:['left','right'].map(port=>({from:{node:'source',port},to:{node:port,port:'in'},queueCapacity:1}))},registry,'cloudflare',budget).workUnits[0]!;
 const bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/in',key:'source'}],['left',{kind:'sink',path:'/left'}],['right',{kind:'sink',path:'/right'}]]);expect(()=>lowerIndependentCommand(work,bindings)).toThrow();
});
it('rejects a connected join with two input sources',()=>{
 const registry=new FeatureRegistry<OperatorDescriptor>();registry.register(descriptor('source','source'));registry.register({...descriptor('join','demux'),inputs:[{name:'left',type:'packet'},{name:'right',type:'packet'}]});registry.register(descriptor('sink','sink'));
 const work=planIndependentGraph({nodes:[{id:'left',featureId:'source'},{id:'right',featureId:'source'},{id:'join',featureId:'join'},{id:'sink',featureId:'sink'}],edges:[...['left','right'].map(id=>({from:{node:id,port:'out'},to:{node:'join',port:id},queueCapacity:1})),{from:{node:'join',port:'out'},to:{node:'sink',port:'in'},queueCapacity:1}]},registry,'cloudflare',budget).workUnits[0]!;
 const bindings=new Map<string,CommandOperatorBinding>([['left',{kind:'source',path:'/left',key:'left'}],['right',{kind:'source',path:'/right',key:'right'}],['join',{kind:'input-options',options:[]}],['sink',{kind:'sink',path:'/out'}]]);expect(()=>lowerIndependentCommand(work,bindings)).toThrow();
});
it('rejects stage order that cannot be represented by one FFmpeg file scope',()=>{
 const work=unit([descriptor('source','source'),descriptor('encode','encode'),descriptor('decode','decode'),descriptor('sink','sink')]),bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/in',key:'source'}],['encode',{kind:'output-options',options:[]}],['decode',{kind:'input-options',options:[]}],['sink',{kind:'sink',path:'/out'}]]);expect(()=>lowerIndependentCommand(work,bindings)).toThrow();
});
it.each(['__proto__','constructor'])('rejects inherited property names masquerading as operator kinds: %s',kind=>{
 const run=fixture(),work={...run.work,graph:{...run.work.graph,nodes:run.work.graph.nodes.map(node=>node.id==='mux'?{...node,operator:Object.assign({},node.operator,{kind})}:node)}};expect(()=>lowerIndependentCommand(work,run.bindings)).toThrow(PlanningError);
});
it.each(['decode','encode','mux'] as const)('rejects repeated non-filter stages instead of silently overwriting options: %s',kind=>{
 const work=unit([descriptor('source','source'),descriptor('first',kind),descriptor('second',kind),descriptor('sink','sink')]),bindingKind=kind==='decode'?'input-options':'output-options';
 const bindings=new Map<string,CommandOperatorBinding>([['source',{kind:'source',path:'/in',key:'source'}],['first',{kind:bindingKind,options:[]}],['second',{kind:bindingKind,options:[]}],['sink',{kind:'sink',path:'/out'}]]);expect(()=>lowerIndependentCommand(work,bindings)).toThrow(PlanningError);
});
it.each(['source','sink','global'] as const)('rejects more than 1024 tokens in an individual fragment: %s',scope=>{
 const run=fixture(),options=Array.from({length:1026},(_,index)=>index%2===0?'-f':'flac');
 if(scope==='source')run.bindings.set('source',{kind:'source',path:'/in',key:'source',options});else if(scope==='sink')run.bindings.set('sink',{kind:'sink',path:'/out',options});
 expect(()=>lowerIndependentCommand(run.work,run.bindings,scope==='global'?{globalArgs:Array(1025).fill('-hide_banner')}:{})).toThrow(PlanningError);
});
it.each(['source','sink','global'] as const)('rejects sparse option arrays with an explicit planning error: %s',scope=>{
 const run=fixture(),options=new Array<string>(2);if(scope==='source')run.bindings.set('source',{kind:'source',path:'/in',key:'source',options});else if(scope==='sink')run.bindings.set('sink',{kind:'sink',path:'/out',options});expect(()=>lowerIndependentCommand(run.work,run.bindings,scope==='global'?{globalArgs:options}:{})).toThrow(PlanningError);
});
it('counts UTF-8 argument bytes rather than JavaScript string length',()=>{
 const run=fixture(),options=Array.from({length:12},()=>['-metadata','title='+'音'.repeat(2000)]).flat();run.bindings.set('sink',{kind:'sink',path:'/out',options});expect(options.join('').length).toBeLessThan(65536);expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow(PlanningError);
});
it.each(['-an','-vn','-sn','-dn'])('rejects output flags bypassing graph stream ownership: %s',flag=>{
 const run=fixture();run.bindings.set('sink',{kind:'sink',path:'/out',options:[flag]});expect(()=>lowerIndependentCommand(run.work,run.bindings)).toThrow(PlanningError);
});
