import {createCrop} from "./crop.js";
import {evaluateSetAspect} from "./set-aspect.js";
import {reduceAspectRational,scaledSampleAspectRatio} from "./scale-aspect.js";
import type {Rational} from '@edge-ffmpeg/avutil';
import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
import {createScaleCommandState} from "./scale-command-state.js";
// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted format negotiation and loss scoring; see ../../NOTICE for provenance.
import {stackGeometry} from "../video-stack.js";
interface Descriptor {kind:'gray'|'rgb'|'yuv';components:number;w:number;h:number;bits:number;alpha:boolean}
const order=['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','argb','rgba','abgr','bgra','yuva420p','gbrp'] as const;
const descriptors:Readonly<Record<string,Descriptor>>={
 gray:{kind:'gray',components:1,w:0,h:0,bits:8,alpha:false},
 yuv420p:{kind:'yuv',components:3,w:1,h:1,bits:12,alpha:false},
 yuv422p:{kind:'yuv',components:3,w:1,h:0,bits:16,alpha:false},
 yuv444p:{kind:'yuv',components:3,w:0,h:0,bits:24,alpha:false},
 yuva420p:{kind:'yuv',components:4,w:1,h:1,bits:20,alpha:true},
 nv12:{kind:'yuv',components:3,w:1,h:1,bits:12,alpha:false},
 nv21:{kind:'yuv',components:3,w:1,h:1,bits:12,alpha:false},
 ...Object.fromEntries(['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'].map(name=>{
  const alpha=!['rgb24','bgr24','gbrp'].includes(name);
  return [name,{kind:'rgb' as const,components:alpha?4:3,w:0,h:0,bits:alpha?32:24,alpha}];
 }))
};
function score(source:string,target:string):number {
 if(source===target)return 2147483647;
 const a=descriptors[source]!,b=descriptors[target]!;let value=2147483646;
 if(b.w>a.w)value-=256<<b.w;if(b.h>a.h)value-=256<<b.h;
 if(b.w===1&&a.w===0&&b.h===1&&a.h===0)value+=512;
 if(b.w<a.w)value-=1<<(a.w-b.w);if(b.h<a.h)value-=1<<(a.h-b.h);
 if(b.kind==='rgb'?a.kind!=='rgb'&&a.kind!=='gray':b.kind==='gray'?a.kind!=='gray':a.kind!=='yuv')value-=Math.min(a.components,b.components)*512;
 if(b.kind==='gray'&&a.kind!=='gray')value-=131072;
 if(a.alpha&&!b.alpha)value-=65536;
 return value;
}
function choose(source:string,values:readonly string[]):string {
 let selected=values[0]!;
 for(const candidate of values.slice(1)){
  const difference=score(source,candidate)-score(source,selected),a=descriptors[selected]!,b=descriptors[candidate]!;
  if(difference>0||difference===0&&(b.bits<a.bits||b.bits===a.bits&&(b.components<a.components||b.components===a.components&&order.indexOf(candidate as typeof order[number])<order.indexOf(selected as typeof order[number]))))selected=candidate;
 }
 return selected;
}
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {parseFilterTopology,filterTopologyOrder} from "../filter-topology.js";
import {resolveVideoFilter} from "./resolver.js";
import type {GraphVideoStep} from "./resolver.js";
interface Group {values:string[];parent:Group}
function group(values:readonly string[]):Group {const result={values:[...values]} as Group;result.parent=result;return result;}
function root(value:Group):Group {let result=value;while(result.parent!==result)result=result.parent;while(value.parent!==value){const next=value.parent;value.parent=result;value=next;}return result;}
function merge(left:Group,right:Group):boolean {
 left=root(left);right=root(right);if(left===right)return true;
 const common=left.values.filter(format=>right.values.includes(format)),alpha=(values:readonly string[])=>values.some(format=>descriptors[format]!.alpha),color=(values:readonly string[])=>values.some(format=>descriptors[format]!.components>1);
 // Keep conversion boundaries when intersection would discard chroma or alpha.
 if(!common.length||alpha(left.values)&&alpha(right.values)&&!alpha(common)||color(left.values)&&color(right.values)&&!color(common))return false;
 left.values=common;right.parent=left;return true;
}
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
 const make=(step:NegotiatedStep,inputs:number,outputs:number):Node=>{const formats=step.name==='format'?step.pixelFormats??order:step.name==='transpose'?order.filter(format=>format!=='yuv422p'):order,common=group(formats);return {step,inputs:[],outputs:[],inputGroups:Array.from({length:inputs},()=>common),outputGroups:Array.from({length:outputs},()=>step.name==='scale'?group(order):common)};};
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
 // Geometry follows dependencies independently of declaration/query registration.
 const remaining=new Set(registration);for(let round=0;remaining.size&&round<=registration.length;round++){
  let progressed=false;for(const node of remaining){if(node.inputs.some(link=>link.geometry===null))continue;const input=node.inputs[0]?.geometry??(node.step.name==='source'?node.step.geometry:sources[0]!);let width=input.width,height=input.height,aspect=input.sampleAspectRatio;
   if(node.step.name==='scale'){if(node.step.scaleWidthExpression!==undefined){const output=node.outputs[0]!.selected!,sub=(format:string)=>({hsub:['yuv420p','yuv422p','yuva420p','nv12','nv21'].includes(format)?2:1,vsub:['yuv420p','yuva420p','nv12','nv21'].includes(format)?2:1}),a=sub(input.format),b=sub(output),state=createScaleCommandState({inputWidth:width,inputHeight:height,width:node.step.scaleWidthExpression,height:node.step.scaleHeightExpression!,...(aspect?{sar:Number(aspect.num)/Number(aspect.den)}:{}),numericProfile:options.numericProfile??'darwin-arm64',evalMode:node.step.scaleEvalMode??'init',...(node.step.scaleForceOriginalAspectRatio===undefined?{}:{forceOriginalAspectRatio:node.step.scaleForceOriginalAspectRatio}),...(node.step.scaleForceDivisibleBy===undefined?{}:{forceDivisibleBy:node.step.scaleForceDivisibleBy}),...(node.step.scaleResetSar===undefined?{}:{resetSar:node.step.scaleResetSar}),...a,ohsub:b.hsub,ovsub:b.vsub});try{width=state.snapshot.width;height=state.snapshot.height;}finally{state.dispose();}}else{width=node.step.width??width;height=node.step.height??height;}}
   else if(node.step.name==='crop'){const state=createCrop({width,height,format:input.format,outWidth:node.step.cropWidth,outHeight:node.step.cropHeight,x:node.step.cropX,y:node.step.cropY,exact:node.step.cropExact,keepAspect:node.step.cropKeepAspect,...(aspect?{sampleAspectRatio:aspect}:{}),numericProfile:options.numericProfile??'darwin-arm64',timeBase:{num:1n,den:25n},maxFrameBytes:2147483647});try{const geometry=state.geometry;width=geometry.width;height=geometry.height;aspect=geometry.sampleAspectRatio;}finally{state.dispose();}}
   else if(node.step.name==='setsar'||node.step.name==='setdar'){aspect=evaluateSetAspect(node.step.expression,node.step.max,input,options.numericProfile??'darwin-arm64');if(node.step.name==='setdar'){const known=aspect.num!==0n;aspect=known?reduceAspectRational(aspect.num*BigInt(height),aspect.den*BigInt(width)):Object.freeze({num:1n,den:1n});node.step={...node.step,frameSampleAspectRatio:known?aspect:Object.freeze({num:0n,den:1n})};}}
   else if(node.step.name==='transpose'&&!((node.step.passthrough===1&&width>=height)||(node.step.passthrough===2&&width<=height))){[width,height]=[height,width];if(aspect?.num)aspect=Object.freeze({num:aspect.den,den:aspect.num});}
   if(node.step.name==='hstack'||node.step.name==='vstack'){const shape=stackGeometry(node.inputs.map(link=>link.geometry!),node.step.name==='hstack'?'horizontal':'vertical');width=shape.width;height=shape.height;}
   if(node.step.name==='scale'&&node.step.scaleResetSar)aspect=Object.freeze({num:1n,den:1n});else if(node.step.name==='scale'&&aspect)aspect=scaledSampleAspectRatio(aspect,input.width,input.height,width,height);
   for(const link of node.outputs){pixelLayout(link.selected!,width,height);link.geometry=Object.freeze({format:link.selected!,width,height,...(aspect?{sampleAspectRatio:aspect}:{})});}
   remaining.delete(node);progressed=true;
  }if(!progressed)throw new Error('Unresolved video graph geometry');
 }
 if(remaining.size)throw new Error('Video graph geometry budget exceeded');
 const indices=new Map(registration.map((node,index)=>[node,index])),originalIndices=new Map(nodes.map((node,index)=>[node,index])),sinkIndices=new Map(sinks.map((node,index)=>[node,index]));
 const registered=Object.freeze(registration.map((node,index)=>{const step=node.step;const snapshot=Object.freeze({...step,...(step.name==='format'&&step.pixelFormats?{pixelFormats:Object.freeze([...step.pixelFormats])}:{})});return Object.freeze({index,step:snapshot,originalIndex:originalIndices.get(node)??null,sourceIndex:sourceBindings.get(node)??null,sinkIndex:sinkIndices.get(node)??null,automatic:automaticNodes.has(node),inputs:Object.freeze(node.inputs.map(link=>link.geometry!)),outputs:Object.freeze(node.outputs.map(link=>link.geometry!))});}));
 const links=Object.freeze(registration.flatMap(node=>node.inputs.map(link=>Object.freeze({from:Object.freeze({node:indices.get(link.from)!,pad:link.fromPad}),to:Object.freeze({node:indices.get(link.to)!,pad:link.toPad}),geometry:link.geometry!}))));
 return Object.freeze({registration:registered,links,nodes:Object.freeze(nodes.map(node=>Object.freeze({name:node.step.name,inputs:Object.freeze(node.inputs.map(link=>link.geometry!)),outputs:Object.freeze(node.outputs.map(link=>link.geometry!))}))),sinks:Object.freeze(sinks.map(node=>node.inputs[0]!.geometry!))});
}
