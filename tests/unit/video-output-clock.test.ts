import {it,expect} from 'vitest';
import {stackFrameRate,rawVideoOutputClock,fillVideoDuration} from '../../packages/avformat/src/video-output/output-clock.js';
const filterTimeBase={num:1n,den:150n};
it('preserves declared rate fields and invalidates mixed stack rates',()=>{
 expect(stackFrameRate([{num:25n,den:1n},{num:50n,den:2n}])).toEqual({num:1n,den:0n});
 expect(stackFrameRate([{num:50n,den:2n},{num:50n,den:2n}])).toEqual({num:50n,den:2n});
});
it('uses CFR fallback independently of variable-rate filter timebase',()=>{
 const sinkFrameRate={num:1n,den:0n};
 expect(rawVideoOutputClock({mode:'cfr',sinkFrameRate,filterTimeBase})).toMatchObject({fallback:true,timeBase:{num:1n,den:25n}});
 expect(rawVideoOutputClock({mode:'vfr',sinkFrameRate,filterTimeBase})).toMatchObject({fallback:false,timeBase:filterTimeBase});
 expect(rawVideoOutputClock({mode:'cfr',sinkFrameRate,filterTimeBase,outputFrameRate:{num:30n,den:1n}})).toMatchObject({fallback:false,timeBase:{num:1n,den:30n}});
 expect(()=>rawVideoOutputClock({mode:'vfr',sinkFrameRate,filterTimeBase,outputFrameRate:{num:30n,den:1n}})).toThrow(/contradicts/);
});
it('retains valid sink clocks and fills duration without using CFR fallback rate',()=>{
 const sinkFrameRate={num:30n,den:1n};
 expect(rawVideoOutputClock({mode:'vfr',sinkFrameRate,filterTimeBase}).timeBase).toEqual({num:1n,den:30n});
 expect(fillVideoDuration(0n,sinkFrameRate,filterTimeBase)).toBe(5n);
 expect(fillVideoDuration(0n,{num:1n,den:0n},filterTimeBase)).toBe(0n);
 expect(fillVideoDuration(3n,sinkFrameRate,filterTimeBase)).toBe(3n);
});

it('selects demux and filter timebases explicitly and rejects unavailable demux clocks',()=>{
 const shared={mode:'cfr' as const,sinkFrameRate:{num:25n,den:1n},filterTimeBase};
 expect(rawVideoOutputClock({...shared,encoderTimeBase:'filter'}).timeBase).toEqual(filterTimeBase);
 expect(rawVideoOutputClock({...shared,encoderTimeBase:'demux',demuxTimeBase:{num:1n,den:1000n}}).timeBase).toEqual({num:1n,den:1000n});
 expect(()=>rawVideoOutputClock({...shared,encoderTimeBase:'demux'})).toThrow(/not available/);
});
