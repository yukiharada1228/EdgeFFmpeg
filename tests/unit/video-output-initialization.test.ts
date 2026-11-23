import {it,expect} from 'vitest';
import {initializeVideoOutput} from '../../packages/avformat/src/video-output/output-initialization.js';
const base={num:1n,den:25n},options={mode:'cfr' as const,sinkFrameRate:{num:25n,den:1n},filterTimeBase:base,outputFrameRate:{num:20n,den:1n}},frame=(value:bigint)=>({payload:String(value),pts:{value,timeBase:base},duration:1n});
it('holds only the first admitted frame and never reopens the source',async()=>{
 let reads=0,closed=0;async function* source(){try{for(const value of [0n,1n,2n,3n]){reads++;yield frame(value);}}finally{closed++;}}
 const output=await initializeVideoOutput(source(),{...options,startUs:20000n});expect(reads).toBe(2);expect(output.hadFilteredFrame).toBe(true);expect(output.clock.timeBase).toEqual({num:1n,den:20n});const iterator=output.frames[Symbol.asyncIterator]();expect((await iterator.next()).value.payload).toBe('1');expect(reads).toBe(2);await output.close();expect(closed).toBe(1);
});
it('uses tentative filter clock when no frames survive trim, ignoring explicit encoder clock',async()=>{
 async function* source(){yield frame(0n);}
 const output=await initializeVideoOutput(source(),{...options,startUs:40000n,encoderTimeBase:{num:1n,den:1000n}});expect(output.hadFilteredFrame).toBe(false);expect(output.clock.timeBase).toEqual(base);expect(output.clock.frameRate).toEqual(options.outputFrameRate);await output.close();
});
it('delays unavailable demux clock validation until a real filtered frame arrives',async()=>{
 async function* empty(){}const output=await initializeVideoOutput(empty(),{...options,encoderTimeBase:'demux'});expect(output.clock.timeBase).toEqual(base);await output.close();
 async function* real(){yield frame(0n);}await expect(initializeVideoOutput(real(),{...options,encoderTimeBase:'demux'})).rejects.toThrow(/not available/);
});
it('cancels after an awaited first read and closes the unconsumed source',async()=>{
 const controller=new AbortController();let closed=0;const source={ [Symbol.asyncIterator](){return {async next(){controller.abort(new Error('cancelled'));return {done:false as const,value:frame(0n)};},async return(){closed++;return {done:true as const,value:undefined};}};}};
 await expect(initializeVideoOutput(source,{...options,signal:controller.signal})).rejects.toThrow('cancelled');expect(closed).toBe(1);
});
it('snapshots requested clocks before awaiting the first frame',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),requested={...options,outputFrameRate:{num:20n,den:1n}};
 async function* source(){await gate;yield frame(0n);}const task=initializeVideoOutput(source(),requested);requested.outputFrameRate.num=60n;release();const initialized=await task;expect(initialized.clock.timeBase).toEqual({num:1n,den:20n});await initialized.close();
});
it('releases the primed source when an acquired iterator returns before its first next',async()=>{
 let closed=0;async function* source(){try{yield frame(0n);yield frame(1n);}finally{closed++;}}
 const initialized=await initializeVideoOutput(source(),options),iterator=initialized.frames[Symbol.asyncIterator]();await iterator.return?.();expect(closed).toBe(1);await initialized.close();expect(closed).toBe(1);
});
it('releases the primed source when close follows iterator acquisition without next',async()=>{
 let closed=0;async function* source(){try{yield frame(0n);yield frame(1n);}finally{closed++;}}
 const initialized=await initializeVideoOutput(source(),options);initialized.frames[Symbol.asyncIterator]();await initialized.close();expect(closed).toBe(1);
});
it('rejects concurrent reads without pulling another source frame',async()=>{
 let reads=0;async function* source(){for(const value of [0n,1n]){reads++;yield frame(value);}}const initialized=await initializeVideoOutput(source(),options),iterator=initialized.frames[Symbol.asyncIterator](),first=iterator.next();await expect(iterator.next()).rejects.toThrow(/Concurrent/);expect((await first).value.payload).toBe('0');expect(reads).toBe(1);await initialized.close();
});
it('makes every close caller wait for in-flight source cleanup',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});async function* source(){try{yield frame(0n);}finally{await gate;}}
 const initialized=await initializeVideoOutput(source(),options),first=initialized.close();let secondDone=false;const second=initialized.close().then(()=>{secondDone=true;});await Promise.resolve();await Promise.resolve();expect(secondDone).toBe(false);release();await Promise.all([first,second]);expect(secondDone).toBe(true);
});
