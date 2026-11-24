// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted format negotiation and loss scoring; see ../../NOTICE for provenance.
import type {Rational} from '@edge-ffmpeg/avutil';
import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
import {scaledSampleAspectRatio} from "./scale-aspect.js";
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {parseFilterTopology,filterTopologyOrder} from "../filter-topology.js";
import {resolveVideoFilter} from "./resolver.js";
import type {GraphVideoStep} from "./resolver.js";
import {videoOperator} from "../video-ops/registry.js";
import {negotiableFormats as order,scaleInputFormats,scaleOutputFormats,requireExecutableFormat,declaredFormats,chooseFormat as choose,formatGroup as group,formatRoot as root,mergeFormats as merge} from "../video-ops/formats.js";
import type {FormatGroup as Group} from "../video-ops/formats.js";
export interface Geometry{readonly sampleAspectRatio?:Rational;readonly format:string;readonly width:number;readonly height:number}
export type NegotiatedStep=GraphVideoStep|{readonly name:'source';readonly geometry:Geometry}|{readonly name:'sink'|'trim'};
interface Node {step:NegotiatedStep;inputs:Link[];outputs:Link[];inputGroups:Group[];outputGroups:Group[]}
interface Link{from:Node;fromPad:number;to:Node;toPad:number;selected:string|null;geometry:Geometry|null}
export interface RegisteredVideoNode {readonly index:number;readonly step:NegotiatedStep;readonly originalIndex:number|null;readonly sourceIndex:number|null;readonly sinkIndex:number|null;readonly automatic:boolean;readonly inputs:readonly Geometry[];readonly outputs:readonly Geometry[]}
export interface RegisteredVideoLink {readonly from:{readonly node:number;readonly pad:number};readonly to:{readonly node:number;readonly pad:number};readonly geometry:Geometry}
export interface NegotiatedTopology{readonly registration:readonly RegisteredVideoNode[];readonly links:readonly RegisteredVideoLink[];readonly nodes:readonly {readonly name:string;readonly inputs:readonly Geometry[];readonly outputs:readonly Geometry[]}[];readonly sinks:readonly Geometry[]}
export function negotiateVideoTopology(description:string,source:Geometry|readonly Geometry[],targets:readonly (string|null)[],options:{readonly numericProfile?:ExpressionNumericProfile;readonly inputTrim?:boolean|readonly boolean[];readonly inputRegistrationOrder?:readonly number[];readonly outputRegistrationOrder?:readonly number[];readonly outputSizes?:readonly ({readonly width:number;readonly height:number}|null)[]}={}):NegotiatedTopology{
 const topology=parseFilterTopology(description,resolveVideoFilter);filterTopologyOrder(topology);
 const descriptions=Array.isArray(source)?source:[source as Geometry];if(!descriptions.length||descriptions.length>32||topology.inputs.length!==descriptions.length||targets.length!==topology.outputs.length)throw new Error('Video graph requires one source per external input and one target per output');
 const sources:readonly Geometry[]=Object.freeze(descriptions.map((geometry:Geometry)=>{const layout=pixelLayout(geometry.format,geometry.width,geometry.height);if(geometry.sampleAspectRatio)scaledSampleAspectRatio(geometry.sampleAspectRatio,1,1,1,1);return Object.freeze({format:layout.pixelFormat,width:geometry.width,height:geometry.height,...(geometry.sampleAspectRatio?{sampleAspectRatio:Object.freeze({...geometry.sampleAspectRatio})}:{})});}));
 const inputOrder=options.inputRegistrationOrder??sources.map((_,index)=>index);if(inputOrder.length!==sources.length||new Set(inputOrder).size!==sources.length||inputOrder.some(index=>!Number.isInteger(index)||index<0||index>=sources.length))throw new Error('Invalid input registration order');
 const trims=Array.isArray(options.inputTrim)?options.inputTrim:sources.map(()=>options.inputTrim===true);if(trims.length!==sources.length||trims.some(value=>typeof value!=='boolean'))throw new Error('Invalid input trim bindings');
 // Pseudo nodes (source, trim, sink) are never registered operators and accept every format.
 const make=(step:NegotiatedStep,inputs:number,outputs:number):Node=>{const op=videoOperator(step.name),resize=op?.role==='resize',common=group(declaredFormats(op?.formats?.(step),op?.jpegSiblings,resize?scaleInputFormats:order));return {step,inputs:[],outputs:[],inputGroups:Array.from({length:inputs},()=>common),outputGroups:Array.from({length:outputs},()=>resize?group(scaleOutputFormats):common)};};
 const nodes=topology.nodes.map(node=>make(node.configuration,node.inputs,node.outputs)),registration=[...nodes],sourceBindings=new Map<Node,number>(),automaticNodes=new Set<Node>();
 const connect=(from:Node,fromPad:number,to:Node,toPad:number):Link=>{const link:Link={from,fromPad,to,toPad,selected:null,geometry:null};from.outputs[fromPad]=link;to.inputs[toPad]=link;return link;};
 for(const edge of topology.edges)connect(nodes[edge.from.node]!,edge.from.pad,nodes[edge.to.node]!,edge.to.pad);
 for(const index of inputOrder){const geometry=sources[index]!,pad=topology.inputs[index]!,input=make({name:'source',geometry},0,1);input.outputGroups=[group([geometry.format])];registration.push(input);sourceBindings.set(input,index);let last=input;
  if(trims[index]){last=make({name:'trim'},1,1);registration.push(last);connect(input,0,last,0);}
  connect(last,0,nodes[pad.node]!,pad.pad);
 }
 if(options.outputSizes&&options.outputSizes.length!==targets.length)throw new Error('Output size binding count mismatch');
 const outputOrder=options.outputRegistrationOrder??topology.outputs.map((_,index)=>index);if(outputOrder.length!==targets.length||new Set(outputOrder).size!==targets.length||outputOrder.some(index=>!Number.isInteger(index)||index<0||index>=targets.length))throw new Error('Invalid output registration order');
 const sinks:Node[]=[];for(const index of outputOrder){const pad=topology.outputs[index]!;
  let from=nodes[pad.node]!,fromPad=pad.pad;const target=targets[index]!;
  const size=options.outputSizes?.[index]??null;if(size){pixelLayout(sources[0]!.format,size.width,size.height);const scale=make({name:'scale',width:size.width,height:size.height},1,1);registration.push(scale);connect(from,fromPad,scale,0);from=scale;fromPad=0;}
  if(target!==null){const format=pixelLayout(target,1,1).pixelFormat,node=make({name:'format',pixelFormat:format,pixelFormats:[format]},1,1);registration.push(node);connect(from,fromPad,node,0);from=node;fromPad=0;}
  const sink=make({name:'sink'},1,0);registration.push(sink);connect(from,fromPad,sink,0);sinks[index]=sink;
 }
 const initialLinks=registration.reduce((count,node)=>count+node.inputs.length,0);let conversions=0;
 for(;;){let retry=false;
  outer:for(const node of registration)for(const link of node.inputs){
   if(merge(link.from.outputGroups[link.fromPad]!,node.inputGroups[link.toPad]!))continue;
   if(++conversions>initialLinks)throw new Error('Branch format negotiation did not converge');
   const automatic=make({name:'scale',width:null,height:null},1,1),from=link.from,fromPad=link.fromPad,toPad=link.toPad;registration.push(automatic);automaticNodes.add(automatic);connect(from,fromPad,automatic,0);connect(automatic,0,node,toPad);
   if(!merge(from.outputGroups[fromPad]!,automatic.inputGroups[0]!)||!merge(automatic.outputGroups[0]!,node.inputGroups[toPad]!))throw new Error('Unsupported branch converter');retry=true;break outer;
  }
  if(!retry)break;
 }
 for(let changed=true;changed;){changed=false;for(const node of registration)for(const link of node.inputs){const input=root(node.inputGroups[link.toPad]!);if(input.values.length!==1)continue;for(const outputGroup of node.outputGroups){const output=root(outputGroup);if(output.values.length>1&&output.values.includes(input.values[0]!)){output.values=[input.values[0]!];changed=true;}}}}
 const select=(link:Link,reference?:string)=>{const formats=root(link.from.outputGroups[link.fromPad]!),selected=reference===undefined?formats.values[0]!:choose(reference,formats.values);if(!selected)throw new Error('Empty graph format group');formats.values=[selected];link.selected=selected;};
 for(let changed=true;changed;){changed=false;for(const node of registration){
  for(const link of [...node.inputs,...node.outputs])if(link.selected===null&&root(link.from.outputGroups[link.fromPad]!).values.length===1){select(link);changed=true;}
  const reference=node.inputs[0]?.selected;if(reference)for(const link of node.outputs)if(link.selected===null){select(link,reference);changed=true;}
 }}
 for(const node of registration)for(const link of [...node.inputs,...node.outputs])if(link.selected===null)select(link);
 // Refuse before geometry or output: a negotiated format without storage here is never substituted.
 for(const node of registration)for(const link of node.inputs)requireExecutableFormat(link.selected!,node.step.name==='sink'?'Video output':`Video filter ${node.step.name} input`);
 // Geometry follows dependencies independently of declaration/query registration.
 const remaining=new Set(registration);for(let round=0;remaining.size&&round<=registration.length;round++){
  let progressed=false;for(const node of remaining){if(node.inputs.some(link=>link.geometry===null))continue;const input=node.inputs[0]?.geometry??(node.step.name==='source'?node.step.geometry:sources[0]!);let width=input.width,height=input.height,aspect=input.sampleAspectRatio;
   const op=videoOperator(node.step.name),inputs=node.inputs.map(link=>link.geometry!);op?.validate?.(input.format,node.step);
   if(op?.timedGeometry){const shape=op.timedGeometry(node.step,{input,inputs,outputFormat:node.outputs[0]?.selected??null,numericProfile:options.numericProfile??'darwin-arm64'});width=shape.width;height=shape.height;aspect=shape.sampleAspectRatio;if(shape.step)node.step=shape.step as NegotiatedStep;}
   else if(op?.geometry)({width,height}=op.geometry(node.step,inputs));
   for(const link of node.outputs){pixelLayout(link.selected!,width,height);link.geometry=Object.freeze({format:link.selected!,width,height,...(aspect?{sampleAspectRatio:aspect}:{})});}
   remaining.delete(node);progressed=true;
  }if(!progressed)throw new Error('Unresolved video graph geometry');
 }
 if(remaining.size)throw new Error('Video graph geometry budget exceeded');
 const indices=new Map(registration.map((node,index)=>[node,index])),originalIndices=new Map(nodes.map((node,index)=>[node,index])),sinkIndices=new Map(sinks.map((node,index)=>[node,index]));
 const registered=Object.freeze(registration.map((node,index)=>{const snapshot=Object.freeze(Object.fromEntries(Object.entries(node.step).map(([key,value])=>[key,Array.isArray(value)?Object.freeze([...value]):value]))) as NegotiatedStep;return Object.freeze({index,step:snapshot,originalIndex:originalIndices.get(node)??null,sourceIndex:sourceBindings.get(node)??null,sinkIndex:sinkIndices.get(node)??null,automatic:automaticNodes.has(node),inputs:Object.freeze(node.inputs.map(link=>link.geometry!)),outputs:Object.freeze(node.outputs.map(link=>link.geometry!))});}));
 const links=Object.freeze(registration.flatMap(node=>node.inputs.map(link=>Object.freeze({from:Object.freeze({node:indices.get(link.from)!,pad:link.fromPad}),to:Object.freeze({node:indices.get(link.to)!,pad:link.toPad}),geometry:link.geometry!}))));
 return Object.freeze({registration:registered,links,nodes:Object.freeze(nodes.map(node=>Object.freeze({name:node.step.name,inputs:Object.freeze(node.inputs.map(link=>link.geometry!)),outputs:Object.freeze(node.outputs.map(link=>link.geometry!))}))),sinks:Object.freeze(sinks.map(node=>node.inputs[0]!.geometry!))});
}
