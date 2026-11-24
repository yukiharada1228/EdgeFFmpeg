// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted format negotiation and loss scoring; see ../NOTICE for provenance.
import {requireVideoPath} from './video-ops/registry.js';
import type {StaticVideoStep} from './video-ops/registry.js';
import {negotiationOrder as order,negotiableFormat,chooseFormat as choose,formatGroup as group,formatRoot as root,mergeFormats as merge} from './video-ops/formats.js';
import type {FormatGroup as Group} from './video-ops/formats.js';
/** Bounded linear negotiation for the currently implemented eight-bit formats. */
export type NegotiationStep=StaticVideoStep;
/** Resize and frame operators in path order; identity operators only constrain formats. */
export interface NegotiatedVideoStage {readonly operation?:string;readonly step:NegotiationStep;readonly pixelFormat:string}
interface Node {step:NegotiationStep|null;input:Group|null;output:Group|null;previous:Node|null;next:Node|null}
export function negotiateVideoFormats(source:string,steps:readonly NegotiationStep[],target?:string,registrationOrder?:readonly number[]):readonly NegotiatedVideoStage[] {
 if(steps.length>34)throw new Error('Video graph exceeds negotiation node limit');
 const supported=negotiableFormat;
 if(!supported(source)||target!==undefined&&!supported(target))throw new Error('Unsupported video negotiation format');
 const nodes:Node[]=steps.map(step=>{
  const op=requireVideoPath(step.name,'linear'),formats=op.formats?.(step);
  if(formats&&(!formats.length||formats.some(format=>!supported(format))||new Set(formats).size!==formats.length))throw new Error('Invalid video format candidates');
  const input=group(formats??order);
  return {step,input,output:op.role==='resize'?group(order):input,previous:null,next:null};
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
  const step=node.step!,role=requireVideoPath(step.name,'linear').role;
  if(role==='resize'||role==='frame')result.push(Object.freeze({...(role==='frame'?{operation:step.name}:{}),step,pixelFormat:selected}));
 }
 return Object.freeze(result);
}
