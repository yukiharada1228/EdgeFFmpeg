import type {CommandGraphLowering,CommandOperatorBinding} from './command-graph.js';
import {commandGraphError as invalid,isCommandGraphPath,isCommandGraphKey,commandGraphTokens as tokens,commandGraphSegment as segment,parseCommandGraphArgs as parse} from './command-graph.js';
import type {IndependentGraphWorkUnit} from './distributed-planner.js';
import type {GraphEdge,PlannedGraph} from './planner.js';

type Node=PlannedGraph['nodes'][number];
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Lower one connected video DAG. Only explicit filter pads branch/join; file
 * prefixes/suffixes stay unary. Multi-pad filter bindings must be single-filter
 * expressions (commas, including quoted commas, are unsupported in that scope).
 * This constructs CLI topology, not proof of registered-feature equivalence.
 */
export function lowerComplexVideoCommand(unit:IndependentGraphWorkUnit,bindings:ReadonlyMap<string,CommandOperatorBinding>,options:{readonly globalArgs?:readonly string[]}={}):CommandGraphLowering {
 const graph=unit.graph;
 if(!graph||!graph.nodes.length||unit.dependencies.length)invalid('Complex command lowering requires one independent component');
 const byId=new Map<string,Node>();
 for(const node of graph.nodes){
  if(!node.id||byId.has(node.id)||!['source','demux','decode','filter','encode','mux','sink'].includes(node.operator.kind))invalid('Invalid complex command node');
  for(const ports of [node.operator.inputs,node.operator.outputs])if(new Set(ports.map(port=>port.name)).size!==ports.length)invalid('Duplicate complex command port');
  byId.set(node.id,node);
 }
 if(bindings.size!==byId.size||unit.nodeIds.length!==byId.size||new Set(unit.nodeIds).size!==byId.size||unit.nodeIds.some(id=>!byId.has(id)))invalid('Complex command binding membership mismatch');
 for(const id of bindings.keys())if(!byId.has(id))invalid('Unknown complex command binding');
 const incoming=new Map<string,GraphEdge[]>(),outgoing=new Map<string,GraphEdge[]>(),inputPads=new Map<string,Map<string,GraphEdge>>(),outputPads=new Map<string,Map<string,GraphEdge>>();
 for(const id of byId.keys()){incoming.set(id,[]);outgoing.set(id,[]);inputPads.set(id,new Map());outputPads.set(id,new Map());}
 for(const edge of graph.edges){
  const from=byId.get(edge.from.node),to=byId.get(edge.to.node);
  if(!from||!to)invalid('Dangling complex command edge');
  const output=from.operator.outputs.find(port=>port.name===edge.from.port),input=to.operator.inputs.find(port=>port.name===edge.to.port);
  if(!output||!input||output.type!==input.type||outputPads.get(from.id)!.has(output.name)||inputPads.get(to.id)!.has(input.name))invalid('Invalid or multiply connected complex command pad');
  outgoing.get(from.id)!.push(edge);incoming.get(to.id)!.push(edge);outputPads.get(from.id)!.set(output.name,edge);inputPads.get(to.id)!.set(input.name,edge);
 }
 const filters=[...byId.values()].filter(node=>node.operator.kind==='filter').sort((a,b)=>compare(a.id,b.id));
 if(!filters.length)invalid('Complex video command requires an explicit filter');
 for(const node of byId.values()){
  if(incoming.get(node.id)!.length!==node.operator.inputs.length||outgoing.get(node.id)!.length!==node.operator.outputs.length)invalid('Unconnected complex command pad, including optional pads');
  if(node.operator.kind==='filter'){
   if(!node.operator.inputs.length||!node.operator.outputs.length||[...node.operator.inputs,...node.operator.outputs].some(port=>port.type!=='video-frame'))invalid('Complex command filters require connected video-frame pads');
  }else if(node.operator.kind==='source'){
   if(incoming.get(node.id)!.length||outgoing.get(node.id)!.length!==1)invalid('Complex command source must have one output');
  }else if(node.operator.kind==='sink'){
   if(outgoing.get(node.id)!.length||incoming.get(node.id)!.length!==1)invalid('Complex command sink must have one input');
  }else if(incoming.get(node.id)!.length!==1||outgoing.get(node.id)!.length!==1)invalid('Nonfilter complex command stages must remain unary');
 }
 // Reject cycles and disconnected membership even for manually forged units.
 const degree=new Map([...byId.keys()].map(id=>[id,incoming.get(id)!.length])),ready=[...degree].filter(([,n])=>n===0).map(([id])=>id),topological:Node[]=[];
 for(let cursor=0;cursor<ready.length;cursor++){
  const id=ready[cursor]!;topological.push(byId.get(id)!);
  for(const edge of outgoing.get(id)!){const next=edge.to.node,count=degree.get(next)!-1;degree.set(next,count);if(count===0)ready.push(next);}
 }
 if(topological.length!==byId.size)invalid('Cyclic complex command graph');
 const connected=new Set<string>([graph.nodes[0]!.id]),pending=[graph.nodes[0]!.id];
 for(let cursor=0;cursor<pending.length;cursor++)for(const edge of [...incoming.get(pending[cursor]!)!,...outgoing.get(pending[cursor]!)!])for(const id of [edge.from.node,edge.to.node])if(!connected.has(id)){connected.add(id);pending.push(id);}
 if(connected.size!==byId.size)invalid('Disconnected complex command graph');
 const binding=(node:Node)=>{const value=bindings.get(node.id);if(!value)invalid('Missing complex command binding');return value;};
 const covered=new Set(filters.map(node=>node.id)),prefixes:Array<{source:Node;path:string;key:string;args:readonly string[];edge:GraphEdge}>=[],suffixes:Array<{sink:Node;path:string;args:readonly string[];edge:GraphEdge}>=[];
 const claim=(node:Node)=>{if(covered.has(node.id))invalid('Shared nonfilter complex command stage');covered.add(node.id);};
 for(const filter of filters){
  for(const port of filter.operator.inputs){
   const edge=inputPads.get(filter.id)!.get(port.name)!;let current=byId.get(edge.from.node)!;
   if(current.operator.kind==='filter')continue;
   const stages:Node[]=[];
   while(current.operator.kind!=='source'){
    if(!['demux','decode'].includes(current.operator.kind))invalid('Invalid complex command input prefix');claim(current);stages.push(current);current=byId.get(incoming.get(current.id)![0]!.from.node)!;
   }
   claim(current);const source=current,sourceBinding=binding(source);
   if(sourceBinding.kind!=='source'||!isCommandGraphPath(sourceBinding.path)||!isCommandGraphKey(sourceBinding.key))invalid('Invalid complex command source binding');
   const args=[...segment(tokens(sourceBinding.options),'input')];let rank=0;
   for(const stage of stages.reverse()){
    const next=stage.operator.kind==='demux'?1:2;if(next<=rank)invalid('Ambiguous or out-of-order complex input prefix');rank=next;
    const value=binding(stage);if(value.kind!=='input-options')invalid('Complex input binding kind mismatch');args.push(...segment(tokens(value.options),'input'));
   }
   prefixes.push({source,path:sourceBinding.path,key:sourceBinding.key,args,edge});
  }
  for(const port of filter.operator.outputs){
   const edge=outputPads.get(filter.id)!.get(port.name)!;let current=byId.get(edge.to.node)!;
   if(current.operator.kind==='filter')continue;
   const args:string[]=[];let rank=0;
   while(current.operator.kind!=='sink'){
    const next=current.operator.kind==='encode'?1:current.operator.kind==='mux'?2:0;
    if(!next||next<=rank)invalid('Invalid or out-of-order complex output suffix');rank=next;claim(current);
    const value=binding(current);if(value.kind!=='output-options')invalid('Complex output binding kind mismatch');args.push(...segment(tokens(value.options),'output'));current=byId.get(outgoing.get(current.id)![0]!.to.node)!;
   }
   claim(current);const value=binding(current);if(value.kind!=='sink'||!isCommandGraphPath(value.path))invalid('Invalid complex command sink binding');
   args.push(...segment(tokens(value.options),'output'));suffixes.push({sink:current,path:value.path,args,edge});
  }
 }
 if(covered.size!==byId.size||!prefixes.length||!suffixes.length)invalid('Complex command graph contains uncovered file stages');
 prefixes.sort((a,b)=>compare(a.source.id,b.source.id));suffixes.sort((a,b)=>compare(a.sink.id,b.sink.id));
 const paths=[...prefixes.map(value=>value.path),...suffixes.map(value=>value.path)];if(new Set(paths).size!==paths.length)invalid('Complex command file paths overlap');
 const labels=new Map<string,Map<string,string>>();filters.forEach((node,index)=>labels.set(node.id,new Map(node.operator.outputs.map((port,pad)=>[port.name,`cg${index}p${pad}`]))));
 const sourceLabels=new Map(prefixes.map((prefix,index)=>[prefix.edge,`${index}:v:0`]));
 let expressionLength=0;
 const fragments=topological.filter(node=>node.operator.kind==='filter').map(node=>{
  const value=binding(node);
  if(value.kind!=='filter'||value.mediaType!=='video'||typeof value.expression!=='string'||!value.expression.trim()||value.expression.length>4096||/[\0;\[\]]/.test(value.expression)||(node.operator.inputs.length>1||node.operator.outputs.length>1)&&value.expression.includes(','))invalid('Unsupported complex video filter expression or binding');
  const inputs=node.operator.inputs.map(port=>{const edge=inputPads.get(node.id)!.get(port.name)!;const label=byId.get(edge.from.node)!.operator.kind==='filter'?labels.get(edge.from.node)!.get(edge.from.port)!:sourceLabels.get(edge)!;return `[${label}]`;}).join('');
  const outputs=node.operator.outputs.map(port=>`[${labels.get(node.id)!.get(port.name)!}]`).join(''),fragment=inputs+value.expression+outputs;
  expressionLength+=fragment.length+(expressionLength?1:0);if(expressionLength>4096)invalid('Complex command filter graph exceeds bounded expression');
  return {id:node.id,fragment};
 });
 // Canonical statement order is independent of supplied node/edge declarations.
 // FFmpeg named links support forward references between these statements.
 fragments.sort((a,b)=>compare(a.id,b.id));
 const globalArgs=segment(tokens(options.globalArgs),'global'),args:string[]=[...globalArgs];
 for(const prefix of prefixes)args.push(...prefix.args,'-i',prefix.path);
 const expression=fragments.map(value=>value.fragment).join(';');args.push('-filter_complex',expression);
 for(const suffix of suffixes){const label=labels.get(suffix.edge.from.node)!.get(suffix.edge.from.port)!;args.push('-map',`[${label}]`,...suffix.args,suffix.path);}
 if(args.length>1024||args.some(value=>value.length>4096)||args.reduce((size,value)=>size+new TextEncoder().encode(value).length,0)>65536)invalid('Complex command exceeds bounded arguments');
 const parsed=parse(args);
 if(parsed.inputs.length!==prefixes.length||parsed.outputs.length!==suffixes.length||parsed.inputs.some((input,index)=>input.url!==prefixes[index]!.path)||parsed.outputs.some((output,index)=>output.url!==suffixes[index]!.path)||parsed.global.filter(option=>option.name==='-filter_complex').length!==1)invalid('Complex command changed declared file scopes');
 for(const [index,output]of parsed.outputs.entries()){
  const suffix=suffixes[index]!,maps=output.options.filter(option=>option.name==='-map');if(maps.length!==1||maps[0]!.value!==`[${labels.get(suffix.edge.from.node)!.get(suffix.edge.from.port)!}]`)invalid('Complex command changed terminal pad mapping');
 }
 return Object.freeze({args:Object.freeze(args),inputs:Object.freeze(prefixes.map(prefix=>Object.freeze({path:prefix.path,key:prefix.key}))),outputs:Object.freeze(suffixes.map(suffix=>Object.freeze({path:suffix.path})))});
}
