import {parseArgv} from '@edge-ffmpeg/cli';
import type {Option,ParsedCommand} from '@edge-ffmpeg/cli';
import type {IndependentGraphWorkUnit} from './distributed-planner.js';
import {PlanningError} from './planner.js';
import type {GraphEdge,OperatorDescriptor,PlannedGraph} from './planner.js';

export type CommandOperatorBinding=
 |{readonly kind:'source';readonly path:string;readonly key:string;readonly options?:readonly string[]}
 |{readonly kind:'input-options';readonly options:readonly string[]}
 |{readonly kind:'filter';readonly mediaType:'audio'|'video';readonly expression:string}
 |{readonly kind:'output-options';readonly options:readonly string[]}
 |{readonly kind:'sink';readonly path:string;readonly options?:readonly string[]};
export interface CommandGraphLowering {readonly args:readonly string[];readonly inputs:readonly {readonly path:string;readonly key:string}[];readonly outputs:readonly {readonly path:string}[]}
const inputOptions=new Set(['-f','-c','-codec','-acodec','-vcodec','-ss','-t','-to','-guess_layout_max','-fflags','-ar','-ac','-r','-video_size','-pixel_format','-framerate','-s']);
const outputOptions=new Set(['-bitexact','-c','-codec','-acodec','-vcodec','-f','-metadata','-map_metadata','-map_chapters','-metadata_header_padding','-fpsmax','-r','-fps_mode','-enc_time_base','-frames','-aframes','-vframes','-ss','-t','-to','-b','-preset','-crf','-ar','-ac','-pix_fmt','-s','-fflags']);
function invalid(message:string):never{throw new PlanningError('invalid-graph',message);}
const path=(value:string)=>typeof value==='string'&&value.startsWith('/')&&value.length<=2048&&!/[\\\0]/.test(value)&&value.slice(1).split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
const key=(value:string)=>typeof value==='string'&&value.length>0&&value.length<=2048&&!value.startsWith('/')&&!/[\\\0]/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
function tokens(values:readonly string[]|undefined):readonly string[]{
 if(values===undefined)return [];
 if(!Array.isArray(values)||values.length>1024)invalid('Invalid command graph option tokens');
 const snapshot=Array.from(values);
 if(snapshot.some(value=>typeof value!=='string'||value.length>4096||value.includes('\0')))invalid('Invalid command graph option tokens');
 return snapshot;
}
function parse(args:readonly string[]):ParsedCommand{try{return parseArgv(args);}catch(error){return invalid(error instanceof Error?error.message:String(error));}}
const inputSentinel='/__edge_command_input__',outputSentinel='/__edge_command_output__';
function segment(values:readonly string[],scope:'global'|'input'|'output'):readonly string[]{
 const parsed=parse(scope==='output'?['-i',inputSentinel,...values,outputSentinel]:[...values,'-i',inputSentinel,outputSentinel]);
 if(parsed.inputs.length!==1||parsed.outputs.length!==1||parsed.inputs[0]!.url!==inputSentinel||parsed.outputs[0]!.url!==outputSentinel)invalid('Command graph options inject a file or input');
 let applicable:readonly Option[];
 if(scope==='global'){
  if(parsed.inputs[0]!.options.length||parsed.outputs[0]!.options.length||parsed.global.some(option=>['-filter_complex','-lavfi'].includes(option.name)))invalid('Inapplicable global command graph options');
  applicable=parsed.global;
 }else{
  if(parsed.global.length||(scope==='input'?parsed.outputs[0]!.options.length:parsed.inputs[0]!.options.length))invalid('Command graph option escapes its file scope');
  applicable=scope==='input'?parsed.inputs[0]!.options:parsed.outputs[0]!.options;
  const allowed=scope==='input'?inputOptions:outputOptions;
  if(applicable.some(option=>!allowed.has(option.name.split(':')[0]!)))invalid('Inapplicable '+scope+' command graph option');
 }
 // Parsing the complete segment is intentional: option values may begin with '-'.
 void applicable;
 return values;
}
/** Lower only a unary linear component into one complete CLI invocation. Binding
 * expressions are filter-chain fragments, not a claim that arbitrary registered
 * operator implementations execute or that Native compatibility is established.
 * Labels/complex topology and raw filter/map overrides are explicitly unsupported.
 */
export function lowerIndependentCommand(unit:IndependentGraphWorkUnit,bindings:ReadonlyMap<string,CommandOperatorBinding>,options:{readonly globalArgs?:readonly string[]}={}):CommandGraphLowering {
 const graph=unit.graph;
 if(!graph||graph.nodes.length<2||unit.dependencies.length)invalid('Command lowering requires an independent source-to-sink component');
 const byId=new Map<string,PlannedGraph['nodes'][number]>();
 for(const node of graph.nodes){if(!node.id||byId.has(node.id))invalid('Invalid or duplicate command graph node');byId.set(node.id,node);}
 if(bindings.size!==byId.size||unit.nodeIds.length!==byId.size||new Set(unit.nodeIds).size!==byId.size||unit.nodeIds.some(id=>!byId.has(id)))invalid('Command graph binding membership mismatch');
 for(const id of bindings.keys())if(!byId.has(id))invalid('Unknown command graph binding');
 const outgoing=new Map<string,GraphEdge>(),incoming=new Map<string,GraphEdge>();
 if(graph.edges.length!==graph.nodes.length-1)invalid('Command lowering requires one linear path');
 for(const edge of graph.edges){
  const from=byId.get(edge.from.node),to=byId.get(edge.to.node);
  if(!from||!to||outgoing.has(from.id)||incoming.has(to.id))invalid('Command graph branches, joins or dangling edges are unsupported');
  const output=from.operator.outputs.find(port=>port.name===edge.from.port),input=to.operator.inputs.find(port=>port.name===edge.to.port);
  if(!output||!input||output.type!==input.type)invalid('Command graph has incompatible media ports');
  outgoing.set(from.id,edge);incoming.set(to.id,edge);
 }
 const starts=graph.nodes.filter(node=>!incoming.has(node.id)),ends=graph.nodes.filter(node=>!outgoing.has(node.id));
 if(starts.length!==1||ends.length!==1||starts[0]!.operator.kind!=='source'||ends[0]!.operator.kind!=='sink')invalid('Command graph requires one source and one sink');
 const ordered:PlannedGraph['nodes'][number][]=[],seen=new Set<string>();
 for(let current:PlannedGraph['nodes'][number]|undefined=starts[0];current;current=outgoing.has(current.id)?byId.get(outgoing.get(current.id)!.to.node):undefined){
  if(seen.has(current.id))invalid('Cyclic command graph');seen.add(current.id);ordered.push(current);
 }
 if(ordered.length!==graph.nodes.length)invalid('Disconnected command graph nodes');
 const ranks:Readonly<Record<OperatorDescriptor['kind'],number>>={source:0,demux:1,decode:2,filter:3,encode:4,mux:5,sink:6};
 const stages=new Set<OperatorDescriptor['kind']>();let previous=-1,mediaType:'audio'|'video'|null=null,sourcePath='',sourceKey='',sinkPath='';
 const inputArgs:string[]=[],outputArgs:string[]=[],expressions:string[]=[];let expressionLength=0;
 for(const node of ordered){
  const kind=node.operator.kind;
  if(!Object.hasOwn(ranks,kind))invalid('Unsupported command graph operator kind');
  const rank=ranks[kind];
  if(rank===undefined||rank<previous||kind!=='filter'&&stages.has(kind))invalid('Ambiguous or out-of-order command graph stages');previous=rank;stages.add(kind);
  const binding=bindings.get(node.id);if(!binding)invalid('Missing command graph binding');
  if(kind==='source'){
   if(binding.kind!=='source'||!path(binding.path)||!key(binding.key))invalid('Invalid command graph source binding');
   sourcePath=binding.path;sourceKey=binding.key;inputArgs.push(...segment(tokens(binding.options),'input'));
  }else if(kind==='sink'){
   if(binding.kind!=='sink'||!path(binding.path))invalid('Invalid command graph sink binding');sinkPath=binding.path;outputArgs.push(...segment(tokens(binding.options),'output'));
  }else if(kind==='demux'||kind==='decode'){
   if(binding.kind!=='input-options')invalid('Command graph input binding kind mismatch');inputArgs.push(...segment(tokens(binding.options),'input'));
  }else if(kind==='filter'){
   if(binding.kind!=='filter'||!['audio','video'].includes(binding.mediaType)||typeof binding.expression!=='string'||!binding.expression.trim()||binding.expression.length>4096||/[\0;\[\]]/.test(binding.expression))invalid('Unsupported command graph filter expression or binding');
   if(mediaType!==null&&mediaType!==binding.mediaType)invalid('Mixed audio/video command graph filters are unsupported');mediaType=binding.mediaType;
   const expected=mediaType==='audio'?'audio-frame':'video-frame';
   const inEdge=incoming.get(node.id)!,outEdge=outgoing.get(node.id)!;
   if(node.operator.inputs.find(port=>port.name===inEdge.to.port)?.type!==expected||node.operator.outputs.find(port=>port.name===outEdge.from.port)?.type!==expected)invalid('Command graph filter media type mismatch');
   expressionLength+=binding.expression.length+(expressions.length?1:0);
   if(expressionLength>4096)invalid('Lowered command graph filter chain exceeds bounded expression');
   expressions.push(binding.expression);
  }else{
   if(binding.kind!=='output-options')invalid('Command graph output binding kind mismatch');outputArgs.push(...segment(tokens(binding.options),'output'));
  }
 }
 if(sourcePath===sinkPath)invalid('Command graph input and output paths overlap');
 const globalArgs=segment(tokens(options.globalArgs),'global'),filterArgs=expressions.length?[mediaType==='audio'?'-af':'-vf',expressions.join(',')]:[];
 const args=[...globalArgs,...inputArgs,'-i',sourcePath,...filterArgs,...outputArgs,sinkPath];
 if(args.length>1024||args.some(value=>value.length>4096)||args.reduce((size,value)=>size+new TextEncoder().encode(value).length,0)>65536)invalid('Lowered command graph exceeds bounded arguments');
 const parsed=parse(args);
 if(parsed.inputs.length!==1||parsed.outputs.length!==1||parsed.inputs[0]!.url!==sourcePath||parsed.outputs[0]!.url!==sinkPath)invalid('Lowered command graph changed file scopes');
 return Object.freeze({args:Object.freeze(args),inputs:Object.freeze([Object.freeze({path:sourcePath,key:sourceKey})]),outputs:Object.freeze([Object.freeze({path:sinkPath})])});
}

// Shared portable validation for the complex-video lowerer; not package exports.
export {invalid as commandGraphError,path as isCommandGraphPath,key as isCommandGraphKey,tokens as commandGraphTokens,segment as commandGraphSegment,parse as parseCommandGraphArgs};
