import {it,expect} from 'vitest';
import {synchronizeVideoOutput} from '../../packages/avformat/src/video-output/output-stream.js';
import type {SyncFrame} from '../../packages/avformat/src/video-output/sync.js';
const base={num:1n,den:25n},options={mode:'cfr' as const,filterTimeBase:base,encoderTimeBase:base,sinkFrameRate:{num:25n,den:1n}},frame=(value:bigint):SyncFrame<string>=>({payload:String(value),pts:{value,timeBase:base},duration:0n});
async function collect<T>(values:AsyncIterable<T>){const all:T[]=[];for await(const value of values)all.push(value);return all;}
it('does not acquire the source for a zero frame output',async()=>{
 let acquired=0;const source={ [Symbol.asyncIterator](){acquired++;throw new Error('source acquired');}};expect(await collect(synchronizeVideoOutput(source,{...options,maxFrames:0n}))).toEqual([]);expect(acquired).toBe(0);
});
it('clips duplicate runs and closes the input immediately at the frame limit',async()=>{
 let pulled=0,closed=0;async function* source(){try{for(const pts of [0n,10n,11n]){pulled++;yield frame(pts);}}finally{closed++;}}
 const output=await collect(synchronizeVideoOutput(source(),{...options,maxFrames:3n}));expect(output.reduce((n,run)=>n+run.count,0n)).toBe(3n);expect(pulled).toBe(2);expect(closed).toBe(1);
});
it('checks cancellation after an awaited input and cleans up without yielding it',async()=>{
 const controller=new AbortController();let closed=0;const source={ [Symbol.asyncIterator](){return {async next(){controller.abort(new Error('cancelled'));return {done:false as const,value:frame(0n)};},async return(){closed++;return {done:true as const,value:undefined};}};}};
 await expect(collect(synchronizeVideoOutput(source,{...options,signal:controller.signal}))).rejects.toThrow('cancelled');expect(closed).toBe(1);
});
it('keeps the processing error when source cleanup also fails',async()=>{
 const source={ [Symbol.asyncIterator](){return {async next(){throw new Error('processing');},async return(){throw new Error('cleanup');}};}};
 await expect(collect(synchronizeVideoOutput(source,options))).rejects.toThrow('processing');
});
it('trims before synchronization and applies the exact encoder deadline',async()=>{
 async function* source(){for(let i=0n;i<10n;i++)yield frame(i);}
 const output=await collect(synchronizeVideoOutput(source(),{...options,startUs:60000n,durationUs:80000n}));expect(output.reduce((n,run)=>n+run.count,0n)).toBe(2n);expect(output[0]?.firstPts).toBe(0n);
});
it('does not pull more input while duplicate runs are suspended and closes on consumer return',async()=>{
 let pulled=0,closed=0;async function* source(){try{for(const value of [0n,10n,11n]){pulled++;yield frame(value);}}finally{closed++;}}
 const output=synchronizeVideoOutput(source(),options)[Symbol.asyncIterator]();expect((await output.next()).done).toBe(false);expect(pulled).toBe(1);
 const previous=await output.next();expect(previous.done).toBe(false);expect(pulled).toBe(2);
 const current=await output.next();expect(current.done).toBe(false);expect(pulled).toBe(2);
 await output.return?.();expect(closed).toBe(1);expect(pulled).toBe(2);
});
