import type {Rational} from '@edge-ffmpeg/avutil';
import {compileMultiInputVideoFilterGraph,filterTopologyOrder,synchronizationTimeBase,videoOperator,videoJoinPlan,videoJoinFrameRate} from '@edge-ffmpeg/avfilter';
export interface SourceClock {readonly frameRate:Rational;readonly timeBase:Rational}
export interface LinkClock extends SourceClock {readonly durationSource:number|null}
/** Inputs are in canonical external-pad order, independent of CLI file order. */
export function videoGraphClocks(description:string,sources:readonly SourceClock[]){
 const {graph}=compileMultiInputVideoFilterGraph(description);if(sources.length!==graph.inputs.length)throw new Error('Source clock binding count mismatch');
 const sourceClocks=sources.map((source,index)=>{for(const q of [source.frameRate,source.timeBase])if(typeof q.num!=='bigint'||typeof q.den!=='bigint'||q.num<=0n||q.den<=0n||q.num>2147483647n||q.den>2147483647n)throw new Error('Invalid source clock');return Object.freeze({frameRate:Object.freeze({...source.frameRate}),timeBase:Object.freeze({...source.timeBase}),durationSource:index});});
 const incoming=graph.nodes.map(node=>Array.from({length:node.inputs},()=>null as {node:number;pad:number}|null)),bindings=new Map(graph.inputs.map((pad,index)=>[`${pad.node}:${pad.pad}`,index]));for(const edge of graph.edges)incoming[edge.to.node]![edge.to.pad]=edge.from;
 const links=new Map<number,LinkClock>();
 for(const index of filterTopologyOrder(graph)){
  const node=graph.nodes[index]!,inputs=incoming[index]!.map((edge,pad)=>edge?links.get(edge.node)!:sourceClocks[bindings.get(`${index}:${pad}`)!]!);if(inputs.some(input=>!input))throw new Error('Unbound timing input');
  const op=videoOperator(node.configuration.name),rule=op?.role==='join'?videoJoinPlan(op,node.configuration,inputs.length):null;
  // A join that copies input 0's frame properties keeps that input's duration and decoder time base.
  const clock=rule?Object.freeze({frameRate:videoJoinFrameRate(rule.rate,inputs.map(input=>input.frameRate)),timeBase:synchronizationTimeBase(inputs.map(input=>input.timeBase)),durationSource:rule.props==='base'?inputs[0]!.durationSource:null}):inputs[0]!;
  links.set(index,clock);
 }
 return Object.freeze({inputs:Object.freeze(sourceClocks),nodes:Object.freeze(graph.nodes.map((_,index)=>links.get(index)!)),outputs:Object.freeze(graph.outputs.map(pad=>links.get(pad.node)!))});
}
