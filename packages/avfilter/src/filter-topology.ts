// SPDX-License-Identifier: LGPL-2.1-or-later
// Pad linking adapted from pinned FFmpeg libavfilter/graphparser.c.
// Copyright (c) 2007 Bobby Bingham; Copyright (c) 2008 Vitor Sessak.
import {filterToken} from './video-syntax.js';
export class FilterTopologyError extends Error {}
export type FilterMediaType='video'|'audio';
export interface FilterPads<T>{readonly inputTypes?:readonly FilterMediaType[];readonly outputTypes?:readonly FilterMediaType[];readonly inputs:number;readonly outputs:number;readonly configuration:T}
export interface FilterToken {readonly name:string;readonly options:string|null}
export interface TopologyNode<T> extends FilterPads<T>{readonly inputTypes:readonly FilterMediaType[];readonly outputTypes:readonly FilterMediaType[];readonly name:string;readonly instanceName:string|null;readonly chainIndex:number;readonly inputLabels:readonly string[];readonly outputLabels:readonly string[]}
export interface TopologyEndpoint{readonly node:number;readonly pad:number}
export interface TopologyEdge{readonly from:TopologyEndpoint;readonly to:TopologyEndpoint}
export interface ExternalPad extends TopologyEndpoint{readonly label:string|null}
export interface FilterTopology<T>{readonly nodes:readonly TopologyNode<T>[];readonly edges:readonly TopologyEdge[];readonly inputs:readonly ExternalPad[];readonly outputs:readonly ExternalPad[]}
interface MutableNode<T>{definition:TopologyNode<T>;inputs:(TopologyEdge|null)[];outputs:(TopologyEdge|null)[]}
const whitespace=(value:string|undefined)=>value!==undefined&&' \t\r\n'.includes(value);
/** Structural linking only. Cycle validation and filter execution are separate. */
export function parseFilterTopology<T>(description:string,resolve:(token:FilterToken)=>FilterPads<T>):FilterTopology<T>{
 if(!description||description.length>4096||description.includes('\0'))throw new FilterTopologyError('Invalid graph description length or NUL');
 description=description.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'\uFFFD');
 const nodes:MutableNode<T>[]=[];let position=0,chainIndex=0,totalPads=0;
 const labels=()=>{const result:string[]=[];while(whitespace(description[position]))position++;while(description[position]==='['){const token=filterToken(description,position+1,']');if(!token.value||description[token.next]!==']')throw new FilterTopologyError('Invalid graph label');result.push(token.value);if(result.length>32)throw new FilterTopologyError('Too many graph labels');position=token.next+1;while(whitespace(description[position]))position++;}return Object.freeze(result);};
 while(position<description.length){
  const inputLabels=labels(),token=filterToken(description,position,'=,;[');position=token.next;const at=token.value.indexOf('@'),name=at<0?token.value:token.value.slice(0,at),instanceName=at<0?null:token.value.slice(at+1);if(!name)throw new FilterTopologyError('Missing filter name');
  let options:string|null=null;if(description[position]==='='){const value=filterToken(description,position+1,'[],;');options=value.value;position=value.next;}
  const outputLabels=labels(),pads=resolve(Object.freeze({name,options}));
  if(![pads.inputs,pads.outputs].every(count=>Number.isInteger(count)&&count>=0&&count<=32))throw new FilterTopologyError('Invalid or excessive filter pad count');
  const inputTypes=Object.freeze([...(pads.inputTypes??Array<FilterMediaType>(pads.inputs).fill('video'))]),outputTypes=Object.freeze([...(pads.outputTypes??Array<FilterMediaType>(pads.outputs).fill('video'))]);if(inputTypes.length!==pads.inputs||outputTypes.length!==pads.outputs||[...inputTypes,...outputTypes].some(type=>type!=='video'&&type!=='audio'))throw new FilterTopologyError('Invalid media pad types');
  totalPads+=pads.inputs+pads.outputs;if(totalPads>128)throw new FilterTopologyError('Graph pad budget exceeded');if(inputLabels.length>pads.inputs||outputLabels.length>pads.outputs)throw new FilterTopologyError('Too many labels for filter pads');
  const definition=Object.freeze({name,instanceName,chainIndex,inputLabels,outputLabels,inputs:pads.inputs,outputs:pads.outputs,inputTypes,outputTypes,configuration:pads.configuration});nodes.push({definition,inputs:Array<TopologyEdge|null>(pads.inputs).fill(null),outputs:Array<TopologyEdge|null>(pads.outputs).fill(null)});if(nodes.length>32)throw new FilterTopologyError('Graph node budget exceeded');
  if(position===description.length)break;const separator=description[position];if(separator!==','&&separator!==';')throw new FilterTopologyError('Trailing graph data');position++;while(whitespace(description[position]))position++;if(separator===';')chainIndex++;
 }
 if(!nodes.length)throw new FilterTopologyError('Missing filter');
 const inputs:ExternalPad[]=[],outputs:ExternalPad[]=[];
 const find=(label:string,output:boolean,start:number):TopologyEndpoint|null=>{for(let index=start;index<nodes.length;index++){const node=nodes[index]!,labels=output?node.definition.outputLabels:node.definition.inputLabels,links=output?node.outputs:node.inputs;for(let pad=0;pad<labels.length;pad++)if(links[pad]===null&&labels[pad]===label)return {node:index,pad};}return null;};
 const link=(from:TopologyEndpoint,to:TopologyEndpoint)=>{const source=nodes[from.node]!,target=nodes[to.node]!;if(source.definition.outputTypes[from.pad]!==target.definition.inputTypes[to.pad])throw new FilterTopologyError('Incompatible media pad types');if(source.outputs[from.pad]!==null||target.inputs[to.pad]!==null)throw new FilterTopologyError('Pad already linked');const edge=Object.freeze({from:Object.freeze({...from}),to:Object.freeze({...to})});source.outputs[from.pad]=edge;target.inputs[to.pad]=edge;};
 for(const [index,node]of nodes.entries()){
  for(let pad=0;pad<node.inputs.length;pad++){
   if(node.inputs[pad]!==null)continue;const label=node.definition.inputLabels[pad]??null,source=label===null?null:find(label,true,index);if(source)link(source,{node:index,pad});else inputs.push(Object.freeze({node:index,pad,label}));
  }
  for(let pad=0;pad<node.outputs.length;pad++){
   if(node.outputs[pad]!==null)continue;const label=node.definition.outputLabels[pad]??null,target=label===null?null:find(label,false,index);if(target){link({node:index,pad},target);continue;}
   const next=nodes[index+1];if(label===null&&next?.definition.chainIndex===node.definition.chainIndex){const input=next.inputs.findIndex((edge,input)=>edge===null&&next.definition.inputLabels[input]===undefined);if(input>=0){link({node:index,pad},{node:index+1,pad:input});continue;}}
   outputs.push(Object.freeze({node:index,pad,label}));
  }
 }
 return Object.freeze({nodes:Object.freeze(nodes.map(node=>node.definition)),edges:Object.freeze(nodes.flatMap(node=>node.outputs.filter((edge):edge is TopologyEdge=>edge!==null))),inputs:Object.freeze(inputs),outputs:Object.freeze(outputs)});
}
/** Bounded Kahn order; parsing may preserve cycles exactly as native parse2 does. */
export function filterTopologyOrder<T>(graph:FilterTopology<T>):readonly number[]{
 if(!graph.nodes.length||graph.nodes.length>32||graph.edges.length>128)throw new FilterTopologyError('Invalid graph execution size');
 const counts=graph.nodes.map(()=>0),successors=graph.nodes.map(()=>[] as number[]);const usedInputs=new Set<string>(),usedOutputs=new Set<string>();
 for(const edge of graph.edges){
  for(const [endpoint,output]of [[edge.from,true],[edge.to,false]] as const){const node=graph.nodes[endpoint.node];if(!Number.isInteger(endpoint.node)||!node||!Number.isInteger(endpoint.pad)||endpoint.pad<0||endpoint.pad>=(output?node.outputs:node.inputs))throw new FilterTopologyError('Invalid execution edge endpoint');const used=output?usedOutputs:usedInputs,key=`${endpoint.node}:${endpoint.pad}`;if(used.has(key))throw new FilterTopologyError('Repeated execution pad');used.add(key);}
  if(graph.nodes[edge.from.node]!.outputTypes[edge.from.pad]!==graph.nodes[edge.to.node]!.inputTypes[edge.to.pad])throw new FilterTopologyError('Incompatible execution media types');
  counts[edge.to.node]=counts[edge.to.node]!+1;successors[edge.from.node]!.push(edge.to.node);}
 const ready=counts.flatMap((count,index)=>count===0?[index]:[]);
 for(let cursor=0;cursor<ready.length;cursor++)for(const target of successors[ready[cursor]!]!){counts[target]=counts[target]!-1;if(counts[target]===0)ready.push(target);}
 if(ready.length!==graph.nodes.length)throw new FilterTopologyError('Cyclic execution graph');return Object.freeze(ready);
}
