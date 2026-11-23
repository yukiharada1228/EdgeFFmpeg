import {it,expect} from 'vitest';import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';import type {ReplayVideoSource} from '@edge-ffmpeg/avfilter';import type {Rational,VideoFrameData} from '@edge-ffmpeg/avutil';
const base={num:1n,den:25n},budget={maxFrameBytes:1024,maxStateBytes:4096,maxResidentBytes:16384,maxSourceTraversals:16};
function source(points:readonly bigint[],offset:number,timeBase:Rational=base,options:{reuse?:boolean;failAt?:number;cleanupError?:boolean}={}){let opens=0,reads=0,closes=0;const shared=Uint8Array.of(0);const descriptor:ReplayVideoSource={geometry:{format:'gray',width:1,height:1},timeBase,open(signal){opens++;return {async *[Symbol.asyncIterator](){try{for(const [index,value]of points.entries()){signal.throwIfAborted();if(options.failAt===index)throw new Error('Input generation changed');reads++;const data=options.reuse?shared:new Uint8Array(1);data[0]=(offset+index)&255;yield {width:1,height:1,pixelFormat:'gray',planes:[data],linesizes:[1],pts:{value,timeBase},metadata:{source:offset}};}}finally{closes++;if(options.cleanupError)throw new Error('Source cleanup failed');}}};}};return {descriptor,get opens(){return opens;},get reads(){return reads;},get closes(){return closes;}};}
async function collect(frames:AsyncIterable<VideoFrameData>){const values=[];for await(const frame of frames)values.push({pts:frame.pts!.value,timeBase:frame.pts!.timeBase,values:[...frame.planes[0]!]});return values;}
it('streams independent input clocks with per-node repeat-last frame synchronization',async()=>{
 const a=source([0n,2n,4n],10),b=source([1n,3n],100),execution=createReplayVideoExecution('[a][b]hstack[out]',[a.descriptor,b.descriptor],['gray'],budget);
 try{const output=await collect(execution.outputs[0]!.frames);expect(output.map(x=>[x.pts,x.values])).toEqual([[1n,[10,100]],[2n,[11,100]],[3n,[11,101]],[4n,[12,101]]]);expect(execution.sourceTraversals).toBe(2);expect([a.opens,b.opens,a.closes,b.closes]).toEqual([1,1,1,1]);}finally{await execution.close();}
});
it('evaluates a shared-source nested join without bounded fanout queue deadlock',async()=>{
 const a=source(Array.from({length:105},(_,i)=>BigInt(i)),10),b=source([100n,103n],100),execution=createReplayVideoExecution('[a]split[x][direct];[x][b]hstack[inner];[inner][direct]hstack[out]',[a.descriptor,b.descriptor],['gray'],budget);
 try{const output=await collect(execution.outputs[0]!.frames);expect(output.map(x=>x.pts)).toEqual([100n,101n,102n,103n,104n]);expect(output[0]!.values).toEqual([110,100,110]);expect(output[4]!.values).toEqual([114,101,114]);expect(execution.sourceTraversals).toBe(3);expect([a.opens,b.opens,a.closes,b.closes]).toEqual([2,1,2,1]);}finally{await execution.close();}
});
it('preserves independent output timelines without a global all-source barrier',async()=>{
 const a=source([0n,2n],10),b=source([0n,1n],100),c=source([10n,20n],70,{num:1n,den:50n}),execution=createReplayVideoExecution('[a][b]hstack[joined];[c]null[plain]',[a.descriptor,b.descriptor,c.descriptor],['gray','gray'],budget),joined=execution.graph.outputs.findIndex(x=>x.label==='joined'),plain=execution.graph.outputs.findIndex(x=>x.label==='plain');
 try{expect((await collect(execution.outputs[joined]!.frames)).map(x=>x.pts)).toEqual([0n,1n,2n]);expect(c.opens).toBe(0);expect(await collect(execution.outputs[plain]!.frames)).toEqual([{pts:10n,timeBase:{num:1n,den:50n},values:[70]},{pts:20n,timeBase:{num:1n,den:50n},values:[71]}]);}finally{await execution.close();}
});
it('rejects replay work and aggregate payload bounds before opening any input',async()=>{
 const a=source([0n],10),b=source([0n],100),graph='[a]split[x][direct];[x][b]hstack[inner];[inner][direct]hstack[out]';expect(()=>createReplayVideoExecution(graph,[a.descriptor,b.descriptor],['gray'],{...budget,maxSourceTraversals:2})).toThrow(/bound/);const good=createReplayVideoExecution(graph,[a.descriptor,b.descriptor],['gray'],budget);const required=good.requiredPayloadBytes;await good.close();expect(()=>createReplayVideoExecution(graph,[a.descriptor,b.descriptor],['gray'],{...budget,maxResidentBytes:required-1})).toThrow(/bound/);expect(a.opens+b.opens).toBe(0);
});
it('isolates reused producer storage and caller mutations from retained join frames',async()=>{
 const a=source([0n,2n,4n],10,base,{reuse:true}),b=source([1n,3n],100,base,{reuse:true}),execution=createReplayVideoExecution('[a][b]hstack[out]',[a.descriptor,b.descriptor],['gray'],budget),iterator=execution.outputs[0]!.frames[Symbol.asyncIterator]();
 try{const first=await iterator.next();expect([...first.value!.planes[0]!]).toEqual([10,100]);first.value!.planes[0]![1]=255;const second=await iterator.next();expect([...second.value!.planes[0]!]).toEqual([11,100]);await iterator.return?.();expect(a.closes+b.closes).toBe(2);}finally{await execution.close();}
});
it('closes suspended producers when cancellation occurs between output reads',async()=>{
 const controller=new AbortController(),a=source([0n,2n,4n],10),b=source([0n,1n,3n],100),execution=createReplayVideoExecution('[a][b]hstack[out]',[a.descriptor,b.descriptor],['gray'],{...budget,signal:controller.signal}),iterator=execution.outputs[0]!.frames[Symbol.asyncIterator]();await iterator.next();controller.abort(new Error('Cancelled execution'));await expect(iterator.next()).rejects.toThrow(/Cancelled/);expect(a.closes+b.closes).toBe(2);await execution.close();
});
it('aborts independent consumers after a source failure and preserves its processing reason',async()=>{
 const a=source([0n,1n],10,base,{failAt:1}),b=source([0n,1n],100,base,{cleanupError:true}),c=source([0n,1n],70),execution=createReplayVideoExecution('[a][b]hstack[joined];[c]null[plain]',[a.descriptor,b.descriptor,c.descriptor],['gray','gray'],budget),joined=execution.outputs[execution.graph.outputs.findIndex(x=>x.label==='joined')]!.frames[Symbol.asyncIterator](),plain=execution.outputs[execution.graph.outputs.findIndex(x=>x.label==='plain')]!.frames[Symbol.asyncIterator]();await plain.next();await joined.next();await expect(joined.next()).rejects.toThrow(/generation changed/);await expect(plain.next()).rejects.toThrow(/generation changed/);expect([a.closes,b.closes,c.closes]).toEqual([1,1,1]);await execution.close();
});
it('bounds operator work and closes already opened sources when its limit is reached',async()=>{
 const a=source([0n,1n,2n],10),b=source([0n,1n,2n],100),execution=createReplayVideoExecution('[a][b]hstack[out]',[a.descriptor,b.descriptor],['gray'],{...budget,maxOperatorSteps:6}),iterator=execution.outputs[0]!.frames[Symbol.asyncIterator]();await expect(iterator.next()).rejects.toThrow(/work budget/);expect(execution.operatorSteps).toBe(6);expect(a.closes+b.closes).toBe(2);await execution.close();
});
it('yields at configured checkpoints and rechecks cancellation before processing or pulling more data',async()=>{
 const controller=new AbortController(),a=source([0n,1n],10),b=source([0n,1n],100);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),steps:number[]=[];
 const execution=createReplayVideoExecution('[a][b]hstack[out]',[a.descriptor,b.descriptor],['gray'],{...budget,signal:controller.signal,checkpointEvery:2,async checkpoint(progress){steps.push(progress.operatorSteps);entered();await gate;}}),iterator=execution.outputs[0]!.frames[Symbol.asyncIterator](),pending=iterator.next();await reached;expect(steps).toEqual([2]);expect(a.reads).toBe(1);expect(b.opens).toBe(0);controller.abort(new Error('Paused by checkpoint'));release();await expect(pending).rejects.toThrow(/checkpoint/);expect(a.closes).toBe(1);expect(b.opens).toBe(0);await execution.close();
});
it('preserves backward PTS through replay and Native join event order',async()=>{
 const a=source([3n,2n,1n],10),b=source([0n,1n,2n],100),execution=createReplayVideoExecution('[a][b]hstack[out]',[a.descriptor,b.descriptor],['gray'],budget);
 try{expect((await collect(execution.outputs[0]!.frames)).map(event=>[event.pts,event.values])).toEqual([[3n,[10,102]],[2n,[11,102]],[1n,[12,102]]]);expect([a.closes,b.closes]).toEqual([1,1]);}finally{await execution.close();}
});
it('preserves unknown source PTS and applies Native stack output rescaling',async()=>{
 const a=source([-9223372036854775808n,0n,-9223372036854775808n],10),b=source([-9223372036854775808n,0n,-9223372036854775808n],100),execution=createReplayVideoExecution('[a][b]hstack[out]',[a.descriptor,b.descriptor],['gray'],budget);
 try{expect((await collect(execution.outputs[0]!.frames)).map(event=>[event.pts,event.values])).toEqual([[-9223372036854775807n,[10,100]],[0n,[11,101]],[-9223372036854775807n,[12,102]]]);expect([a.closes,b.closes]).toEqual([1,1]);}finally{await execution.close();}
});
