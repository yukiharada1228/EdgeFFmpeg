import {it,expect} from 'vitest';
import {createVideoOutputLimit} from '../../packages/avformat/src/video-output/output-limit.js';
const timeBase={num:1n,den:25n},run=(firstPts:bigint,count:bigint)=>({payload:'x',firstPts,count,duration:1n,timeBase});
it('clips huge compressed duplication runs using aggregate output frame limits',()=>{
 const limit=createVideoOutputLimit({timeBase,maxFrames:3n,durationUs:null});expect(limit.take(run(0n,2n))?.count).toBe(2n);expect(limit.take(run(2n,1000000000000n))?.count).toBe(1n);expect(limit.frames).toBe(3n);expect(limit.closed).toBe(true);expect(limit.take(run(3n,1n))).toBe(null);
});
it('uses exact rational duration deadlines independently of rounding to frame ticks',()=>{
 const tiny=createVideoOutputLimit({timeBase,maxFrames:null,durationUs:1n});expect(tiny.take(run(0n,10n))?.count).toBe(1n);
 const exact=createVideoOutputLimit({timeBase,maxFrames:null,durationUs:80000n});expect(exact.take(run(0n,10n))?.count).toBe(2n);
 const late=createVideoOutputLimit({timeBase,maxFrames:null,durationUs:80000n});expect(late.take(run(4n,1n))).toBe(null);expect(late.closed).toBe(true);
});
it('combines independent limits and preserves payload identity',()=>{
 const zero=createVideoOutputLimit({timeBase,maxFrames:0n,durationUs:null});expect(zero.closed).toBe(true);
 const limit=createVideoOutputLimit({timeBase,maxFrames:100n,durationUs:0n});expect(limit.take(run(0n,1n))).toBe(null);
 const unbounded=createVideoOutputLimit({timeBase,maxFrames:null,durationUs:null}),input=run(5n,1n);expect(unbounded.take(input)?.payload).toBe(input.payload);expect(unbounded.closed).toBe(false);
});

it('keeps accepting equal passthrough timestamps at the last permitted tick',()=>{const limit=createVideoOutputLimit({timeBase,maxFrames:null,durationUs:80000n});expect(limit.take(run(1n,1n))?.count).toBe(1n);expect(limit.closed).toBe(false);expect(limit.take(run(1n,1n))?.count).toBe(1n);expect(limit.frames).toBe(2n);expect(limit.take(run(2n,1n))).toBe(null);expect(limit.closed).toBe(true);});
