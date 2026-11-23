// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted format negotiation and loss scoring; see ../NOTICE for provenance.
import {negatePixelFormats} from './video-negate.js';
/** Bounded linear negotiation for the currently implemented eight-bit formats. */
export type NegotiationStep = {readonly name:'transpose';readonly direction:number;readonly passthrough:number} | {readonly name:'null'|'hflip'|'vflip'} | {readonly name:'format';readonly pixelFormats:readonly string[]|null} | {readonly name:'scale';readonly width:number|null;readonly height:number|null} | {readonly name:'negate';readonly components:number;readonly negateAlpha:boolean};
export interface NegotiatedVideoStage {readonly operation?:'hflip'|'vflip'|'transpose'|'negate';readonly negate?:{readonly components:number;readonly negateAlpha:boolean};readonly direction?:number;readonly passthrough?:number;readonly width:number|null;readonly height:number|null;readonly pixelFormat:string}
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
interface Group {values:string[];parent:Group}
interface Node {step:NegotiationStep|null;input:Group|null;output:Group|null;previous:Node|null;next:Node|null}
function group(values:readonly string[]):Group {const result={values:[...values]} as Group;result.parent=result;return result;}
function root(value:Group):Group {let result=value;while(result.parent!==result)result=result.parent;while(value.parent!==value){const next=value.parent;value.parent=result;value=next;}return result;}
function merge(left:Group,right:Group):boolean {
 left=root(left);right=root(right);if(left===right)return true;
 const common=left.values.filter(format=>right.values.includes(format)),alpha=(values:readonly string[])=>values.some(format=>descriptors[format]!.alpha),color=(values:readonly string[])=>values.some(format=>descriptors[format]!.components>1);
 // Keep conversion boundaries when intersection would discard chroma or alpha.
 if(!common.length||alpha(left.values)&&alpha(right.values)&&!alpha(common)||color(left.values)&&color(right.values)&&!color(common))return false;
 left.values=common;right.parent=left;return true;
}
export function negotiateVideoFormats(source:string,steps:readonly NegotiationStep[],target?:string,registrationOrder?:readonly number[]):readonly NegotiatedVideoStage[] {
 if(steps.length>34)throw new Error('Video graph exceeds negotiation node limit');
 const supported=(format:string)=>Object.hasOwn(descriptors,format);
 if(!supported(source)||target!==undefined&&!supported(target))throw new Error('Unsupported video negotiation format');
 const nodes:Node[]=steps.map(step=>{
  if(step.name==='format'&&step.pixelFormats!==null&&(!step.pixelFormats.length||step.pixelFormats.some(format=>!supported(format))||new Set(step.pixelFormats).size!==step.pixelFormats.length))throw new Error('Invalid video format candidates');
  const input=group(step.name==='format'?step.pixelFormats??order:step.name==='transpose'?order.filter(format=>format!=='yuv422p'):step.name==='negate'?order.filter(format=>negatePixelFormats.includes(format)):order);
  return {step,input,output:step.name==='scale'?group(order):input,previous:null,next:null};
 });
 const start:Node={step:null,input:null,output:group([source]),previous:null,next:null},end:Node={step:null,input:group(target?[target]:order),output:null,previous:null,next:null},path=[start,...nodes,end];
 for(let i=1;i<path.length;i++){path[i]!.previous=path[i-1]!;path[i-1]!.next=path[i]!;}
 const registrationIndices=registrationOrder??nodes.map((_,index)=>index);if(registrationIndices.length!==nodes.length||new Set(registrationIndices).size!==nodes.length||registrationIndices.some(index=>!Number.isInteger(index)||index<0||index>=nodes.length))throw new Error('Invalid filter registration order');
 const registration=[...registrationIndices.map(index=>nodes[index]!),start,end];let inserted=0;
 for(;;){let retry=false;
  for(const node of registration){
   if(!node.input||merge(node.previous!.output!,node.input))continue;
   if(++inserted>steps.length+1)throw new Error('Video format negotiation did not converge');
   const automatic:Node={step:{name:'scale',width:null,height:null},input:group(order),output:group(order),previous:node.previous,next:node};
   node.previous!.next=automatic;node.previous=automatic;registration.push(automatic);
   if(!merge(automatic.previous!.output!,automatic.input!)||!merge(automatic.output!,node.input))throw new Error('Cannot negotiate automatic video conversion');
   retry=true;break;
  }
  if(!retry)break;
 }
 // Propagate singleton inputs before scoring the remaining candidate sets.
 for(let changed=true;changed;){changed=false;for(const node of registration){
  if(!node.input||!node.output)continue;const input=root(node.input),output=root(node.output);
  if(input.values.length===1&&output.values.length>1&&output.values.includes(input.values[0]!)){output.values=[input.values[0]!];changed=true;}
 }}
 const result:NegotiatedVideoStage[]=[];let current=source;
 for(let node=start.next!;node!==end;node=node.next!){
  const output=root(node.output!),selected=choose(current,output.values);output.values=[selected];current=selected;
  if(node.step?.name==='scale')result.push(Object.freeze({width:node.step.width,height:node.step.height,pixelFormat:selected}));
  else if(node.step?.name==='transpose')result.push(Object.freeze({width:null,height:null,pixelFormat:selected,operation:'transpose',direction:node.step.direction,passthrough:node.step.passthrough}));
  else if(node.step?.name==='hflip'||node.step?.name==='vflip')result.push(Object.freeze({width:null,height:null,pixelFormat:selected,operation:node.step.name}));
  else if(node.step?.name==='negate')result.push(Object.freeze({width:null,height:null,pixelFormat:selected,operation:'negate',negate:Object.freeze({components:node.step.components,negateAlpha:node.step.negateAlpha})}));
 }
 return Object.freeze(result);
}
