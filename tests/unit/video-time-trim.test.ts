import {it,expect} from 'vitest';
import {createVideoTimeTrim,beforeVideoDeadline} from '../../packages/avformat/src/video-output/video-trim.js';
const base={num:1n,den:25n};
it('anchors duration to the first admitted timestamp rather than requested start',()=>{
 const trim=createVideoTimeTrim(base,{startUs:60000n,durationUs:80000n});
 expect([0n,1n,3n,4n,5n,6n].filter(pts=>trim.accept(pts))).toEqual([3n,4n]);expect(trim.firstPts).toBe(3n);expect(trim.eof).toBe(true);
});
it('treats duration rounded to zero as disabled, with the encoder deadline remaining exact',()=>{
 for(const durationUs of [0n,1n,19999n]){const trim=createVideoTimeTrim(base,{startUs:null,durationUs});expect([0n,1n,2n].every(pts=>trim.accept(pts))).toBe(true);}
 expect(beforeVideoDeadline(0n,base,0n)).toBe(false);expect(beforeVideoDeadline(0n,base,1n)).toBe(true);expect(beforeVideoDeadline(1n,base,1n)).toBe(false);
});
it('handles unknown timestamps according to active start and duration constraints',()=>{
 const free=createVideoTimeTrim(base,{startUs:null,durationUs:null});expect(free.accept(null)).toBe(true);expect(free.firstPts).toBe(null);
 const start=createVideoTimeTrim(base,{startUs:0n,durationUs:null});expect(start.accept(null)).toBe(false);expect(start.eof).toBe(false);
 const limited=createVideoTimeTrim(base,{startUs:null,durationUs:40000n});expect(limited.accept(null)).toBe(false);expect(limited.eof).toBe(true);
});
