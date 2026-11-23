import {it,expect} from 'vitest';import {createVideoEncoderSync,encoderPts,roundEven} from '../../packages/avformat/src/video-output/sync.js';import type {SyncRun} from '../../packages/avformat/src/video-output/sync.js';
const base={num:1n,den:25n},frame=(payload:string,value:bigint,duration=1n)=>({payload,pts:{value,timeBase:base},duration});
const expand=(runs:readonly SyncRun<string>[])=>runs.flatMap(run=>Array.from({length:Number(run.count)},(_,index)=>({payload:run.payload,pts:run.firstPts+BigInt(index),duration:run.duration})));
it('uses native nearest-even and extended-clock midpoint bias instead of JS integer rounding',()=>{
 expect([0.5,1.5,2.5,-0.5,-1.5,-2.5].map(roundEven)).toEqual([0n,2n,2n,0n,-2n,-2n]);const adjusted=encoderPts({value:1n,timeBase:base},base,20000n);expect(adjusted.rounded).toBe(0n);expect(adjusted.exact).toBe(0.5+1/131072);
 const sync=createVideoEncoderSync<string>({mode:'cfr',timeBase:base,startTimeUs:20000n});expect(expand(sync.push(frame('a',1n)))).toEqual([{payload:'a',pts:0n,duration:1n},{payload:'a',pts:1n,duration:1n}]);
});
it('preserves fixed-rate cadence and emits no flush frames when no history requires it',()=>{
 const sync=createVideoEncoderSync<string>({mode:'cfr',timeBase:base});for(let i=0;i<3;i++)expect(expand(sync.push(frame(String(i),BigInt(i))))).toEqual([{payload:String(i),pts:BigInt(i),duration:1n}]);expect(sync.finish()).toEqual([]);expect(sync.finish()).toEqual([]);expect(sync.frameNumber).toBe(3n);expect(()=>sync.push(frame('x',3n))).toThrow(/closed/);
});
it('selects previous-frame copies and median EOF repetitions without allocating per-copy arrays',()=>{
 const sync=createVideoEncoderSync<string>({mode:'cfr',timeBase:base}),output=[...expand(sync.push(frame('a',0n,0n))),...expand(sync.push(frame('b',3n,0n))),...expand(sync.push(frame('c',6n,0n))),...expand(sync.finish())];expect(output.map(x=>x.payload)).toEqual(['a','a','b','b','b','c','c']);expect(output.map(x=>x.pts)).toEqual([0n,1n,2n,3n,4n,5n,6n]);expect(sync.nextPts).toBe(7n);
 const burst=createVideoEncoderSync<string>({mode:'cfr',timeBase:base});expect(burst.push(frame('first',1000000n)).length).toBe(1);expect(burst.frameNumber).toBe(1000001n);
});
it('uses VSCFR startup suppression and VFR timeline jumps independently',()=>{
 const variableStartup=createVideoEncoderSync<string>({mode:'vscfr',timeBase:base});expect(expand(variableStartup.push(frame('start',5n)))).toEqual([{payload:'start',pts:5n,duration:1n}]);
 const vfr=createVideoEncoderSync<string>({mode:'vfr',timeBase:{num:1n,den:150n}}),output=[];for(const value of [0n,5n,6n,10n,12n])output.push(...expand(vfr.push({payload:String(value),pts:{value,timeBase:{num:1n,den:150n}},duration:0n})));expect(output.map(x=>x.pts)).toEqual([0n,5n,6n,10n,12n]);expect(output.every(x=>x.duration===0n)).toBe(true);
 expect(vfr.push({payload:'duplicate',pts:{value:12n,timeBase:{num:1n,den:150n}},duration:0n})).toEqual([]);
});
it('enforces duplication budgets and preserves the native excessive-duplication skip',()=>{
 const bounded=createVideoEncoderSync<string>({mode:'cfr',timeBase:base,maxCopiesPerFrame:2n});expect(()=>bounded.push(frame('gap',4n))).toThrow(/duplication exceeds budget/);
 const nativeSkip=createVideoEncoderSync<string>({mode:'cfr',timeBase:base,maxCopiesPerFrame:1n});expect(nativeSkip.push(frame('too far',4000000n))).toEqual([]);expect(nativeSkip.frameNumber).toBe(0n);
 expect(()=>createVideoEncoderSync({mode:'cfr',timeBase:{num:1n,den:0n}})).toThrow(/clock/);expect(()=>encoderPts({value:9007199254740993n,timeBase:base},base,0n)).toThrow(/signed64/);
});

it('preserves the dropped state at EOF when no frame was ever emitted',()=>{
 const sync=createVideoEncoderSync<string>({mode:'cfr',timeBase:base,startTimeUs:500000n});
 for(let i=0;i<3;i++)expect(sync.push(frame(String(i),BigInt(i)))).toEqual([]);
 expect(sync.lastDropped).toBe(true);expect(sync.frameNumber).toBe(0n);expect(sync.finish()).toEqual([]);expect(sync.lastDropped).toBe(true);
});
