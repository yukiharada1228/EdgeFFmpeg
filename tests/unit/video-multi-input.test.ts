import {it,expect} from 'vitest';
import {compileMultiInputVideoFilterGraph as compileMultiFrameGraph,compileVideoFilterGraph as compileFrameGraph} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
function gray(width:number,height:number,value:number,padding=0):VideoFrameData{return {width,height,pixelFormat:'gray',planes:[new Uint8Array((height-1)*(width+padding)+width).fill(value)],linesizes:[width+padding],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{input:value}};}
const budget={maxFrameBytes:16384,maxStateBytes:65536,maxResidentBytes:262144};
it('binds independent frame sources by external input pad rather than node declaration order',()=>{
 const graph=compileMultiFrameGraph('[a][b]hstack[out]'),plan=graph.plan([{format:'gray',width:2,height:2},{format:'gray',width:3,height:2}],['gray']),a=gray(2,2,11,1),b=gray(3,2,77,2),out=plan.applyBatch([a,b],budget)[0]!;
 expect(graph.graph.inputs.map(x=>x.label)).toEqual(['a','b']);expect([out.width,out.height]).toEqual([5,2]);expect([...out.planes[0]!]).toEqual([11,11,77,77,77,11,11,77,77,77]);expect(out.pts).toEqual(a.pts);out.planes[0]![0]=88;expect(a.planes[0]![0]).toBe(11);expect(b.planes[0]![0]).toBe(77);
 expect(()=>compileFrameGraph('[a][b]hstack[out]')).toThrow(/one external/);
});
it('supports three inputs shared join constraints nested joins and separate sinks',()=>{
 const graph=compileMultiFrameGraph('[x][z]vstack,split[left][right];[a][b]hstack,scale=3:2[x]'),sources=graph.graph.inputs.map(()=>({format:'gray',width:3,height:2})),plan=graph.plan(sources,['gray','rgb24'],{inputTrim:graph.graph.inputs.map((_,index)=>index===1),inputRegistrationOrder:[2,0,1],outputSizes:[null,{width:6,height:4}]}),out=plan.applyBatch(sources.map((x,index)=>gray(x.width,x.height,index*40)),budget);
 expect(out.map(x=>[x.width,x.height,x.pixelFormat])).toEqual([[3,4,'gray'],[6,4,'rgb24']]);expect(out[0]!.metadata).toEqual({});
});
it('preflights binding counts geometry timestamps and aggregate padded input storage',()=>{
 const graph=compileMultiFrameGraph('[a][b]hstack[out]'),sources=[{format:'gray',width:3,height:2},{format:'gray',width:3,height:2}];expect(()=>graph.plan(sources.slice(1),['gray'])).toThrow(/binding/);
 for(const options of [{inputTrim:[true]},{inputRegistrationOrder:[0,0]},{inputRegistrationOrder:[0,2]}])expect(()=>graph.plan(sources,['gray'],options)).toThrow();
 const plan=graph.plan(sources,['gray']),a=gray(3,2,1),b=gray(3,2,2),exact={maxFrameBytes:plan.maxFrameBytes,maxStateBytes:plan.stateBytes,maxResidentBytes:plan.requiredPayloadBytes};expect(()=>plan.applyBatch([a,b],exact)).not.toThrow();
 expect(()=>plan.applyBatch([a],budget)).toThrow(/binding/);expect(()=>plan.applyBatch([a,gray(4,2,3)],budget)).toThrow(/source/);expect(()=>plan.applyBatch([a,{...b,pts:null}],budget)).toThrow(/synchronized/);
 expect(()=>plan.applyBatch([gray(3,2,1,1),b],exact)).toThrow(/budget/);
});
it('processes a synchronized batch stream without prefetch and closes the source on cancellation',async()=>{
 const plan=compileMultiFrameGraph('[a][b]hstack[out]').plan([{format:'gray',width:3,height:2},{format:'gray',width:3,height:2}],['gray']);let pulled=0,closed=false;async function* frames(){try{for(let i=0;i<3;i++){pulled++;yield [gray(3,2,1),gray(3,2,2)];}}finally{closed=true;}}
 const controller=new AbortController(),iterator=plan.processBatches(frames(),{...budget,signal:controller.signal})[Symbol.asyncIterator]();await iterator.next();expect(pulled).toBe(1);controller.abort();await expect(iterator.next()).rejects.toThrow();expect(pulled).toBe(1);expect(closed).toBe(true);
});
it('resolves each join clock locally while independent output branches preserve their source clock',()=>{
 const graph=compileMultiFrameGraph('[a][b]hstack[joined];[c]null[plain]'),plan=graph.plan(Array.from({length:3},()=>({format:'gray',width:3,height:2})),['gray','gray']),a=gray(3,2,1),b=gray(3,2,2),c=gray(3,2,3);b.pts={value:a.pts!.value*2n,timeBase:{num:1n,den:50n}};
 const output=plan.applyBatch([a,b,c],budget),joined=output[graph.graph.outputs.findIndex(x=>x.label==='joined')]!,plain=output[graph.graph.outputs.findIndex(x=>x.label==='plain')]!;
 expect(joined.pts).toEqual({value:a.pts!.value*2n,timeBase:{num:1n,den:50n}});expect(plain.pts).toEqual(c.pts);expect(b.pts.timeBase).toEqual({num:1n,den:50n});expect(joined.metadata).toEqual({});expect(plain.metadata).toEqual(c.metadata);
});
