import {it,expect} from 'vitest';
import {stackVideoFrames,stackGeometry} from '../../packages/avfilter/src/video-stack.js';
import {compileVideoFilterGraph as compileFrameGraph} from '@edge-ffmpeg/avfilter';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
function frame(format='gray',width=3,height=2,padding=0):VideoFrameData{const layout=pixelLayout(format,width,height);return {width,height,pixelFormat:format,planes:layout.planes.map((plane,p)=>Uint8Array.from({length:(plane.height-1)*(plane.rowBytes+padding)+plane.rowBytes},(_,i)=>(i+p*43+1)&255)),linesizes:layout.planes.map(plane=>plane.rowBytes+padding),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{source:'input'}};}
const budget={maxFrameBytes:8192,maxStateBytes:65536,maxResidentBytes:262144};
it('stacks padded synchronized gray frames with independent owned output and exact timestamps',()=>{
 const a=frame('gray',3,2,2),b=frame('gray',3,2,1),before=a.planes[0]!.slice();
 const h=stackVideoFrames([a,b],'horizontal',budget),v=stackVideoFrames([a,b],'vertical',budget);
 expect([...h.planes[0]!]).toEqual([1,2,3,1,2,3,6,7,8,5,6,7]);expect([...v.planes[0]!]).toEqual([1,2,3,6,7,8,1,2,3,5,6,7]);
 expect(h.pts).toEqual(a.pts);expect(h.pts).not.toBe(a.pts);expect(h.metadata).toEqual({});h.planes[0]![0]=99;expect(a.planes[0]).toEqual(before);
});
it('plans all fourteen layouts with clipped final odd chroma boundaries and rejects overlapping native placements',()=>{
 const formats=['gray','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'];
 for(const format of formats)for(const direction of ['horizontal','vertical'] as const){const output=stackVideoFrames([frame(format,3,3,3),frame(format,3,3,1)],direction,budget);expect(output.planes.map(x=>x.length)).toEqual(pixelLayout(format,output.width,output.height).planes.map(x=>x.bytes));}
 for(const format of ['yuv420p','yuva420p','nv12','nv21'])for(const direction of ['horizontal','vertical'] as const)expect(()=>stackGeometry(Array(3).fill({format,width:3,height:3}),direction)).toThrow(/overlap/);
});
it('rejects mismatched geometry format timestamps storage and output budgets before allocation',()=>{
 const a=frame(),b=frame();for(const bad of [frame('gray',3,3),frame('rgb24'),{...b,pts:null},{...b,pts:{value:0n,timeBase:{num:1n,den:25n}}},{...b,planes:[new Uint8Array(1)]},{...b,linesizes:[-3]}])expect(()=>stackVideoFrames([a,bad],'horizontal',budget)).toThrow();
 expect(()=>stackVideoFrames([a,b],'horizontal',{maxFrameBytes:11})).toThrow();const controller=new AbortController();controller.abort();expect(()=>stackVideoFrames([a,b],'horizontal',{...budget,signal:controller.signal})).toThrow();
});
it('executes branch joins by input pad order independently of declaration order',()=>{
 const text='[left][right]hstack[out];[a]hflip[left];[b]vflip[right];split[a][b]',graph=compileFrameGraph(text),plan=graph.plan({format:'gray',width:3,height:2},['gray']),source=frame();
 const output=plan.apply(source,budget)[0]!;expect([output.width,output.height]).toEqual([6,2]);expect([...output.planes[0]!]).toEqual([3,2,1,4,5,6,6,5,4,1,2,3]);expect(output.metadata).toEqual({});
 const exact={maxFrameBytes:plan.maxFrameBytes,maxStateBytes:plan.stateBytes,maxResidentBytes:plan.requiredPayloadBytes};expect(()=>plan.apply(source,exact)).not.toThrow();expect(()=>plan.apply(source,{...exact,maxResidentBytes:exact.maxResidentBytes-1})).toThrow();
});
it('supports nested joins and independent sink conversions without accepting unsynchronized external sources',()=>{
 const plan=compileFrameGraph('split=3[a][b][c];[a][b]hstack[x];[x]scale=3:2[y];[y][c]vstack,split[left][right]').plan({format:'gray',width:3,height:2},['gray','rgb24']);
 const outputs=plan.apply(frame(),budget);expect(outputs.map(x=>[x.width,x.height,x.pixelFormat])).toEqual([[3,4,'gray'],[3,4,'rgb24']]);expect(()=>compileFrameGraph('[a][b]hstack')).toThrow(/one external/);
});
it('freezes placement metadata and rejects invalid axes and retained padded storage',()=>{
 const plan=stackGeometry([{format:'gray',width:3,height:2},{format:'gray',width:3,height:2}],'horizontal');
 for(const value of [plan,plan.layout,plan.regions,...plan.regions,...plan.regions.flat()])expect(Object.isFrozen(value)).toBe(true);
 expect(()=>stackGeometry([{format:'gray',width:3,height:2},{format:'gray',width:3,height:2}],'invalid' as 'horizontal')).toThrow(/direction/);
 const source=frame();expect(()=>stackVideoFrames([{...source,planes:[new Uint8Array(100)]},source],'horizontal',{maxFrameBytes:12})).toThrow(/storage/);
});
it('compares synchronized timestamps as exact rationals and validates time-base types',()=>{
 const a=frame(),b=frame();b.pts={value:a.pts!.value*2n,timeBase:{num:1n,den:50n}};expect(stackVideoFrames([a,b],'horizontal',budget).pts).toEqual(a.pts);
 for(const timeBase of [{num:0n,den:25n},{num:1n,den:0n},{num:1,den:25n}])expect(()=>stackVideoFrames([a,{...b,pts:{value:1n,timeBase:timeBase as {num:bigint;den:bigint}}}],'horizontal',budget)).toThrow(/timestamp/);
});
it('joins thirty-two pad-bound branches without implicit fanout or ownership aliasing',()=>{
 const names=Array.from({length:32},(_,i)=>`[p${i}]`).join(''),plan=compileFrameGraph(`split=32${names};${names}hstack=inputs=32:shortest=1[out]`).plan({format:'gray',width:1,height:1},['gray']),source=frame('gray',1,1),output=plan.apply(source,budget)[0]!;
 expect([output.width,output.height]).toEqual([32,1]);expect([...output.planes[0]!]).toEqual(Array(32).fill(1));output.planes[0]![0]=2;expect(source.planes[0]![0]).toBe(1);
});
it('streams joined outputs with one source pull per batch and closes on consumer termination',async()=>{
 let pulls=0,closed=false;async function* source(){try{for(let i=0;i<3;i++){pulls++;yield frame();}}finally{closed=true;}}
 const plan=compileFrameGraph('split[a][b];[a][b]vstack[out]').plan({format:'gray',width:3,height:2},['gray']),iterator=plan.process(source(),budget)[Symbol.asyncIterator]();expect(pulls).toBe(0);
 const next=await iterator.next();expect(next.done).toBe(false);expect(next.value![0]!.height).toBe(4);expect(pulls).toBe(1);await iterator.return?.();expect(closed).toBe(true);expect(pulls).toBe(1);
});
