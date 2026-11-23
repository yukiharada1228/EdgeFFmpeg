import {markDirectVideoOutput} from '../video-output/timestamp-options.js';
import {videoOptionMatches} from '../video-output/stream-option.js';
import {resolveVideoCommandOptions} from '../video-output/option-order.js';
// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped rawvideo stream selection adapts fftools/ffmpeg_mux_init.c map_auto_video
// at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../../NOTICE.
import type {ParsedCommand,Option} from '@edge-ffmpeg/cli';
import {ExecutionError} from '@edge-ffmpeg/core';
import {parseVideoSize} from '@edge-ffmpeg/avutil';
import {parseFilterTopology,filterTopologyOrder,resolveVideoFilter} from '@edge-ffmpeg/avfilter';
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
const invalid=(message:string):never=>{throw new ExecutionError('invalid-arguments',message);};
const whitespace=(value:string|undefined)=>value!==undefined&&' \n\r\t'.includes(value);
/** Locate raw graph tokens without decoding their quote/escape layers. */
function tokenEnd(text:string,start:number,terminators:string):number {
 let position=start;while(position<text.length&&!terminators.includes(text[position]!)){const character=text[position++]!;if(character==='\\'&&position<text.length)position++;else if(character==="'"){while(position<text.length&&text[position]!=="'")position++;if(position<text.length)position++;}}return position;
}
function rawNodes(text:string):string[]{
 const result:string[]=[];let position=0;
 const labels=()=>{while(whitespace(text[position]))position++;while(text[position]==='['){position=tokenEnd(text,position+1,']');if(text[position]!==']')invalid('Invalid simple graph label');position++;while(whitespace(text[position]))position++;}};
 while(position<text.length){labels();const start=position;position=tokenEnd(text,position,'=,;[');if(text[position]==='=')position=tokenEnd(text,position+1,'[],;');result.push(text.slice(start,position));labels();if(position===text.length)break;if(![',',';'].includes(text[position]!))invalid('Invalid simple graph separator');position++;while(whitespace(text[position]))position++;}
 return result;
}
/** Rebind a one-input/one-output graph while preserving its original filter tokens. */
function bindSimpleGraph(description:string,source:number,output:number):string {
 const graph=parseFilterTopology(description,resolveVideoFilter);filterTopologyOrder(graph);if(graph.inputs.length!==1||graph.outputs.length!==1)unsupported('Simple video filter requires exactly one input and one output');
 const raw=rawNodes(description);if(raw.length!==graph.nodes.length)invalid('Simple graph token count mismatch');
 const label=(node:number,pad:number)=>`__edge_simple_${output}_${node}_${pad}`,sink=graph.outputs[0]!,input=graph.inputs[0]!;
 return graph.nodes.map((node,index)=>{
  const inputs=Array.from({length:node.inputs},(_,pad)=>{if(input.node===index&&input.pad===pad)return `[${source}:v]`;const edge=graph.edges.find(edge=>edge.to.node===index&&edge.to.pad===pad);if(!edge)invalid('Unbound simple graph input');return `[${label(edge!.from.node,edge!.from.pad)}]`;});
  const outputs=Array.from({length:node.outputs},(_,pad)=>`[${sink.node===index&&sink.pad===pad?`__edge_output_${output}`:label(index,pad)}]`);
  return inputs.join('')+raw[index]!+outputs.join('');
 }).join(';');
}
function filterOption(option:Option):'match'|'ignore'|null {
 if(option.name==='-vf')return 'match';if(option.name.split(':')[0]!=='-filter')return null;
 try{return videoOptionMatches(option.name)?'match':'ignore';}catch(error){return unsupported(error instanceof Error?error.message:'Unsupported simple filter stream specifier');}
}
export function normalizeSimpleVideoCommand(command:ParsedCommand,hasPackets?:readonly boolean[],defaultSource?:number):ParsedCommand {
 command=resolveVideoCommandOptions(command);
 if(!command.inputs.length||!command.outputs.length)invalid('Missing simple video input or output');if(command.inputs.length>32)unsupported('At most thirty-two simple video inputs are implemented');
 const areas=command.inputs.map((input,index)=>{let size:{width:number;height:number}|undefined;for(const option of input.options)if(option.name==='-s'||option.name==='-video_size')size=parseVideoSize(option.value??'');if(!size)invalid('Declared rawvideo dimensions are required');return BigInt(size!.width)*BigInt(size!.height)+(hasPackets?.[index]?100000000n:0n);});
 let best=0;for(let index=1;index<areas.length;index++)if(areas[index]!>areas[best]!)best=index;
 const graphs:string[]=[],outputs=command.outputs.map((output,index)=>{
  let source:number|undefined,description='null';const options:Option[]=[];
  for(const option of output.options){const filter=filterOption(option);if(filter){if(filter==='match')description=option.value??'';continue;}if(option.name==='-map'){if(source!==undefined)unsupported('Multiple mapped video streams per output remain unimplemented');const match=/^(0|[1-9]\d*)(?::(?:0|v(?::0)?))?(\?)?$/.exec(option.value??'');if(!match)unsupported('Unsupported simple video map');source=Number(match![1]);if(!Number.isSafeInteger(source)||source>=command.inputs.length)invalid('Simple video map input is absent');continue;}options.push({...option});}
  graphs.push(bindSimpleGraph(description,source??defaultSource??best,index));options.push({name:'-map',value:`[__edge_output_${index}]`});return markDirectVideoOutput({url:output.url,options});
 });
 return {global:[...command.global.map(option=>({...option})),{name:'-filter_complex',value:graphs.join(';')}],inputs:command.inputs.map(input=>({...input,options:input.options.map(option=>({...option}))})),outputs};
}
