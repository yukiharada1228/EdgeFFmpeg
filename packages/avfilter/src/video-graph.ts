// SPDX-License-Identifier: LGPL-2.1-or-later
// Single-path pad linking follows pinned FFmpeg libavfilter/graphparser.c.
import {filterToken} from './video-syntax.js';
import {parseVideoFilterToken} from './video-parse.js';
import type {ParsedVideoStep} from './video-parse.js';
export class VideoGraphError extends Error {}
interface Node {name:string;instance:string|null;options:string|null;chain:number;inputLabel:string|null;outputLabel:string|null;input:number|null;output:number|null}
export interface VideoGraphNode {readonly declarationIndex:number;readonly chainIndex:number;readonly inputLabel?:string;readonly outputLabel?:string;readonly instanceName?:string}
export type GraphVideoStep=ParsedVideoStep&{readonly graph?:VideoGraphNode};
const space=(character:string|undefined)=>character!==undefined&&' \t\r\n'.includes(character);
function nodesFrom(description:string):Node[]{
 if(!description||description.length>4096||description.includes('\0'))throw new VideoGraphError('Invalid video filter description length or NUL');
 // Native UTF-8 argv replaces unpaired UTF-16 units; preserve BOM and valid pairs.
 description=description.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'\uFFFD');
 let position=0,chain=0;const nodes:Node[]=[];
 const labels=()=>{const values:string[]=[];while(space(description[position]))position++;while(description[position]==='['){const token=filterToken(description,position+1,']');if(!token.value||description[token.next]!==']')throw new VideoGraphError('Invalid filter link label');values.push(token.value);position=token.next+1;while(space(description[position]))position++;}if(values.length>1)throw new VideoGraphError('Declared video filters have one input and one output');return values[0]??null;};
 while(position<description.length){
  const inputLabel=labels(),token=filterToken(description,position,'=,;[');position=token.next;const at=token.value.indexOf('@'),name=at<0?token.value:token.value.slice(0,at),instance=at<0?null:token.value.slice(at+1);if(!name)throw new VideoGraphError('Missing video filter name');
  let options:string|null=null;if(description[position]==='='){const value=filterToken(description,position+1,'[],;');options=value.value;position=value.next;}
  const outputLabel=labels();nodes.push({name,instance,options,chain,inputLabel,outputLabel,input:null,output:null});if(nodes.length>32)throw new VideoGraphError('Video filter chain exceeds node limit');
  if(position===description.length)break;const separator=description[position];if(separator!==','&&separator!==';')throw new VideoGraphError('Trailing filter graph data');position++;while(space(description[position]))position++;if(separator===';')chain++;
 }
 if(!nodes.length)throw new VideoGraphError('Missing video filter');return nodes;
}
export function parseVideoGraph(description:string):{readonly steps:readonly GraphVideoStep[];readonly registrationOrder:readonly number[]}{
 const nodes=nodesFrom(description),parsed=nodes.map(node=>parseVideoFilterToken({name:node.name,options:node.options})),inputs:number[]=[],outputs:number[]=[];
 const link=(source:number,destination:number)=>{if(source===destination)throw new VideoGraphError('A filter cannot link to itself');if(nodes[source]!.output!==null||nodes[destination]!.input!==null)throw new VideoGraphError('Filter pad already linked');nodes[source]!.output=destination;nodes[destination]!.input=source;};
 // Search only current/later declarations, consuming each matched pad once.
 for(const [index,node]of nodes.entries()){
  if(node.input===null){const source=node.inputLabel===null?-1:nodes.findIndex((candidate,other)=>other>=index&&candidate.output===null&&candidate.outputLabel===node.inputLabel);if(source>=0)link(source,index);else inputs.push(index);}
  if(node.output===null){const destination=node.outputLabel===null?-1:nodes.findIndex((candidate,other)=>other>=index&&candidate.input===null&&candidate.inputLabel===node.outputLabel);if(destination>=0)link(index,destination);else if(node.outputLabel===null&&nodes[index+1]?.chain===node.chain&&nodes[index+1]!.input===null&&nodes[index+1]!.inputLabel===null)link(index,index+1);else outputs.push(index);}
 }
 if(inputs.length!==1||outputs.length!==1)throw new VideoGraphError('Simple video graphs require exactly one input and one output');
 const flow:number[]=[],visited=new Set<number>();let current:number|null=inputs[0]!;
 while(current!==null){if(visited.has(current))throw new VideoGraphError('Filter graph cycle');visited.add(current);flow.push(current);current=nodes[current]!.output;}
 if(flow.length!==nodes.length||flow.at(-1)!==outputs[0])throw new VideoGraphError('Disconnected or cyclic filter graph');
 const annotated=nodes.some(node=>node.inputLabel!==null||node.outputLabel!==null||node.instance!==null)||nodes.some(node=>node.chain>0);
 const steps=Object.freeze(flow.map(index=>{const node=nodes[index]!;if(!annotated)return parsed[index]!;const graph:VideoGraphNode=Object.freeze({declarationIndex:index,chainIndex:node.chain,...(node.inputLabel!==null?{inputLabel:node.inputLabel}:{}),...(node.outputLabel!==null?{outputLabel:node.outputLabel}:{}),...(node.instance!==null?{instanceName:node.instance}:{})});return Object.freeze({...parsed[index]!,graph});}));
 const registrationOrder=Object.freeze(flow.map((_,index)=>index).sort((a,b)=>flow[a]!-flow[b]!));return Object.freeze({steps,registrationOrder});
}
