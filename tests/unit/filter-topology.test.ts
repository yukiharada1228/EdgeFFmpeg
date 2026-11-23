import {expect,it} from 'vitest';
import {parseFilterTopology,filterTopologyOrder,FilterTopologyError} from '@edge-ffmpeg/avfilter';
import type {FilterPads,FilterToken} from '@edge-ffmpeg/avfilter';
const resolve=(token:FilterToken):FilterPads<null>=>({inputs:token.name==='nullsrc'?0:1,outputs:token.name==='nullsink'?0:token.name==='split'?2:1,configuration:null});
it('bounds structural graphs and rejects oversized registry descriptors before pad allocation',()=>{
 for(const text of [' '.repeat(4097),'null\0bad',Array(33).fill('null').join(',')])expect(()=>parseFilterTopology(text,resolve)).toThrow(FilterTopologyError);
 for(const count of [NaN,-1,33,2147483647])expect(()=>parseFilterTopology('split',()=>({inputs:1,outputs:count,configuration:null}))).toThrow(FilterTopologyError);
 expect(()=>parseFilterTopology('split;split;split;split',()=>({inputs:1,outputs:32,configuration:null}))).toThrow(FilterTopologyError);
});
it('retains immutable branch endpoints and schedules source fork and sinks by dependency',()=>{
 const graph=parseFilterTopology('nullsrc,split[a][b];[a]nullsink;[b]nullsink',resolve);expect(graph.inputs).toEqual([]);expect(graph.outputs).toEqual([]);expect(filterTopologyOrder(graph)).toEqual([0,1,2,3]);
 for(const value of [graph,graph.nodes,graph.edges,graph.inputs,graph.outputs,...graph.nodes,...graph.edges,...graph.nodes.flatMap(node=>[node.inputLabels,node.outputLabels,node.inputTypes,node.outputTypes]),...graph.edges.flatMap(edge=>[edge.from,edge.to])])expect(Object.isFrozen(value)).toBe(true);
});
it('rejects forged execution endpoints and repeated pads without permitting implicit fanout',()=>{
 const graph=parseFilterTopology('null,hflip',resolve),edge=graph.edges[0]!;
 expect(()=>filterTopologyOrder({...graph,edges:[{...edge,from:{node:99,pad:0}}]})).toThrow(FilterTopologyError);
 expect(()=>filterTopologyOrder({...graph,edges:[edge,edge]})).toThrow(FilterTopologyError);
});
