import {it,expect} from 'vitest';
import {videoGraphClocks} from '../../packages/avformat/src/video-output/graph-clock.js';
const source=(num:bigint,den=1n)=>({frameRate:{num,den},timeBase:{num:den,den:num}});
it('preserves separate clocks through split, conversions and reordered outputs',()=>{
 const plan=videoGraphClocks('[a]split[x][y];[y]hflip[o1];[x]scale=2:2[o0];[b]null[o2]',[source(25n),source(30n)]);
 expect(plan.outputs.map(output=>output.frameRate)).toEqual([{num:25n,den:1n},{num:25n,den:1n},{num:30n,den:1n}]);
 expect(plan.outputs.map(output=>output.durationSource)).toEqual([0,0,1]);
});
it('computes local stack clocks and keeps nested unknown frame rates',()=>{
 const plan=videoGraphClocks('[a][b]hstack[j];[j][c]vstack[o]',[source(25n),source(30n),source(25n)]);
 expect(plan.outputs[0]).toEqual({frameRate:{num:1n,den:0n},timeBase:{num:1n,den:150n},durationSource:null});
});
it('compares raw frame-rate fields and preserves unreduced synchronization clocks',()=>{
 const equal=videoGraphClocks('[a][b]hstack[o]',[source(50n,2n),source(50n,2n)]).outputs[0]!;
 expect(equal).toEqual({frameRate:{num:50n,den:2n},timeBase:{num:2n,den:50n},durationSource:null});
 const equivalent=videoGraphClocks('[a][b]hstack[o]',[source(25n),source(50n,2n)]).outputs[0]!;
 expect(equivalent.frameRate).toEqual({num:1n,den:0n});expect(equivalent.timeBase).toEqual({num:1n,den:50n});
});
it('rejects mismatched bindings, invalid rates and feedback graphs',()=>{
 expect(()=>videoGraphClocks('[a]null[o]',[])).toThrow(/binding count/);
 expect(()=>videoGraphClocks('[a]null[o]',[source(0n)])).toThrow(/clock/);
 expect(()=>videoGraphClocks('[y]split[y][o]',[])).toThrow();
});
