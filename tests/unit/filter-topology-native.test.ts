import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {parseFilterTopology,filterTopologyOrder} from '@edge-ffmpeg/avfilter';
import type {FilterToken,FilterPads} from '@edge-ffmpeg/avfilter';
import {filterOptions} from '../../packages/avfilter/src/video-syntax.js';
import {parseVideoFilterToken} from '../../packages/avfilter/src/video-parse.js';
function resolve(token:FilterToken):FilterPads<unknown>{
 if(['asplit','anull','anullsink','anullsrc','amix','amerge','showwaves'].includes(token.name)){
  let inputs=token.name==='anullsrc'?0:['amix','amerge'].includes(token.name)?2:1,outputs=token.name==='anullsink'?0:token.name==='asplit'?2:1;
  const key=token.name==='asplit'?'outputs':['amix','amerge'].includes(token.name)?'inputs':null;
  for(const option of filterOptions(token.options,key?[key]:[])){const count=Number(option.value);if(option.key!==key||!/^\d+$/.test(option.value)||!Number.isInteger(count)||count<1||count>32)throw new Error('Unsupported audio count');if(key==='outputs')outputs=count;else inputs=count;}
  return {inputs,outputs,inputTypes:Array(inputs).fill('audio'),outputTypes:Array(outputs).fill(token.name==='showwaves'?'video':'audio'),configuration:token};
 }
 if(['split','hstack','vstack'].includes(token.name)){
  const key=token.name==='split'?'outputs':'inputs';let count=2;
  for(const option of filterOptions(token.options,[key])){if(option.key!==key||!/^\d+$/.test(option.value)||!Number.isInteger(Number(option.value))||Number(option.value)<1||Number(option.value)>32)throw new Error('Unsupported count');count=Number(option.value);}
  return {inputs:token.name==='split'?1:count,outputs:token.name==='split'?count:1,configuration:Object.freeze({name:token.name,count})};
 }
 if(['nullsink','nullsrc','color','overlay'].includes(token.name)){
  if(filterOptions(token.options,[]).length)throw new Error('Unsupported topology-only options');return {inputs:token.name==='nullsink'?1:token.name==='overlay'?2:0,outputs:token.name==='nullsink'?0:1,configuration:token};
 }
 return {inputs:1,outputs:1,configuration:parseVideoFilterToken(token)};
}

it('replays 210 pinned native structural graphs including media types reused labels and cycles',()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/filter-topology-native.json','utf8')) as {reference:{commit:string;flags:string[]};oracleSourceSha256:string;cases:{description:string;native:{accepted:boolean;nodes:unknown[];edges:{from:number[];to:number[]}[];inputs:unknown[];outputs:unknown[]}}[]};
 const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string;configureFile:string};
 expect(fixture.reference.commit).toBe(lock.commit);
 expect(fixture.reference.flags).toEqual(readFileSync(lock.configureFile,'utf8').trim().split(/\s+/));
 expect(createHash('sha256').update(readFileSync('tools/differential-runner/filter-graph/topology-oracle.c')).digest('hex')).toBe(fixture.oracleSourceSha256);
 expect(fixture.cases).toHaveLength(210);
 for(const {description,native} of fixture.cases){
let actual:ReturnType<typeof parseFilterTopology>|null=null;try{actual=parseFilterTopology(description,resolve);}catch{}
 expect(actual!==null,description).toBe(native.accepted);if(actual){expect(actual.nodes.map(node=>({name:node.name,instanceName:node.instanceName,inputs:node.inputs,outputs:node.outputs,inputTypes:node.inputTypes,outputTypes:node.outputTypes})),description).toEqual(native.nodes);expect(actual.edges.map(edge=>({from:[edge.from.node,edge.from.pad],to:[edge.to.node,edge.to.pad]})),description).toEqual(native.edges);expect(actual.inputs,description).toEqual(native.inputs);expect(actual.outputs,description).toEqual(native.outputs);for(const node of actual.nodes)expect(Object.isFrozen(node)).toBe(true);const cyclic=description==='[x]null[x]'||description==='[b]hflip[a];[a]vflip[b]';if(cyclic)expect(()=>filterTopologyOrder(actual!)).toThrow();else{const order=filterTopologyOrder(actual),positions=new Map(order.map((node,index)=>[node,index]));expect(new Set(order).size).toBe(actual.nodes.length);for(const edge of native.edges)expect(positions.get(edge.from[0]!)!,description).toBeLessThan(positions.get(edge.to[0]!)!);}}
 }
});
