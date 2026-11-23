import {expect,it} from 'vitest';
import {createAacCopyClock} from '../../packages/containers/src/mp4/aac-copy-clock.js';
it('preserves Native sample-clock correction for coarse AAC timestamps',()=>{
 // Captured from pinned ffmpeg -debug_ts: AAC44100/1024, input1/1000,
 // muxer clocks0,1024,2048,3065 for demux DTS0,23,46,69.
 const clock=createAacCopyClock({num:1n,den:1000n},44100,1024);
 expect([0n,23n,46n,69n].map(clock)).toEqual([0n,1024n,2048n,3065n]);
 expect(clock(-12n)).toBe(-529n); // discontinuity falls back to nearest rescale
 expect(()=>clock(-(1n<<63n))).toThrow(/Invalid AAC copy timestamp/);
});
