import {expect,it} from 'vitest';
import {compileVideoFilterGraph as compileFrameGraph} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
const frame=():VideoFrameData=>({width:3,height:2,pixelFormat:'gray',planes:[Uint8Array.of(1,2,3,99,4,5,6,99)],linesizes:[4],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{seed:7}});
const budget={maxFrameBytes:65536,maxStateBytes:65536,maxResidentBytes:1024*1024};
it('returns independent tight outputs from shared split storage and preserves padded source ownership',()=>{
 const plan=compileFrameGraph('[in]split[a][b];[a]null[left];[b]null[right]').plan({format:'gray',width:3,height:2},[null,null]),source=frame(),outputs=plan.apply(source,budget);
 expect(outputs.map(output=>output.linesizes)).toEqual([[3],[3]]);expect(outputs[0]!.planes[0]).toEqual(Uint8Array.of(1,2,3,4,5,6));expect(outputs[0]!.pts).toEqual(source.pts);
 outputs[0]!.planes[0]![0]=42;outputs[0]!.metadata.seed=99;expect(outputs[1]!.planes[0]![0]).toBe(1);expect(source.planes[0]![0]).toBe(1);expect(outputs[1]!.metadata.seed).toBe(7);expect(source.metadata.seed).toBe(7);
});
it('rejects frame scratch aggregate storage and cancellation before graph processing',()=>{
 const plan=compileFrameGraph('split[a][b];[a]scale=13:7[left];[b]format=rgba[right]').plan({format:'gray',width:3,height:2},[null,null]);
 for(const patch of [{maxFrameBytes:2},{maxStateBytes:0},{maxResidentBytes:1},{maxResidentBytes:NaN},{signal:AbortSignal.abort()}])expect(()=>plan.apply(frame(),{...budget,...patch})).toThrow();
 expect(()=>plan.apply({...frame(),linesizes:[2]},budget)).toThrow();expect(()=>plan.apply({...frame(),width:2},budget)).toThrow();
});
it('pulls one source frame per output batch and closes upstream when the consumer stops',async()=>{
 let pulls=0,closed=false;const frames=(async function*(){try{for(let i=0;i<3;i++){pulls++;yield frame();}}finally{closed=true;}})(),plan=compileFrameGraph('split[left][right]').plan({format:'gray',width:3,height:2},[null,null]),stream=plan.process(frames,budget)[Symbol.asyncIterator]();
 expect(pulls).toBe(0);const first=await stream.next();expect(first.value).toHaveLength(2);expect(pulls).toBe(1);await stream.return?.();expect(pulls).toBe(1);expect(closed).toBe(true);
});
it('propagates cancellation between batches and closes upstream without prefetch',async()=>{
 const controller=new AbortController();let pulls=0,closed=false;const frames=(async function*(){try{for(let i=0;i<3;i++){pulls++;yield frame();}}finally{closed=true;}})(),plan=compileFrameGraph('split[left][right]').plan({format:'gray',width:3,height:2},[null,null]),stream=plan.process(frames,{...budget,signal:controller.signal})[Symbol.asyncIterator]();
 await stream.next();controller.abort();await expect(stream.next()).rejects.toThrow();expect(pulls).toBe(1);expect(closed).toBe(true);
});

it('preflights invalid stream budgets before acquiring or pulling the upstream iterator',async()=>{
 let opened=0,pulls=0;const source:AsyncIterable<VideoFrameData>={[Symbol.asyncIterator](){opened++;return {async next(){pulls++;return {done:false,value:frame()};}};}},plan=compileFrameGraph('split[left][right]').plan({format:'gray',width:3,height:2},[null,null]);
 await expect(plan.process(source,{...budget,maxResidentBytes:1})[Symbol.asyncIterator]().next()).rejects.toThrow();expect(opened).toBe(0);expect(pulls).toBe(0);
});
it('plans independent output sizes and keeps output storage and payload preflight separate',()=>{
 const graph=compileFrameGraph('split[left][right]'),plan=graph.plan({format:'gray',width:3,height:2},['rgba','gray'],{outputSizes:[{width:5,height:4},{width:2,height:3}]});expect(plan.negotiated.sinks).toEqual([{format:'rgba',width:5,height:4},{format:'gray',width:2,height:3}]);
 const output=plan.apply(frame(),budget);expect(output.map(item=>[item.pixelFormat,item.width,item.height])).toEqual([['rgba',5,4],['gray',2,3]]);expect(output.map(item=>item.planes.reduce((sum,plane)=>sum+plane.length,0))).toEqual([80,6]);
 expect(()=>graph.plan({format:'gray',width:3,height:2},[null,null],{outputSizes:[null]})).toThrow();expect(()=>graph.plan({format:'gray',width:3,height:2},[null,null],{outputSizes:[{width:0,height:2},null]})).toThrow();
});
