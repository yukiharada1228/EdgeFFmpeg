import {expect,it} from 'vitest';import {planComplexVideo} from '../../packages/avformat/src/complex-video-plan.js';
const budget={maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},input=['-f','rawvideo','-pixel_format','gray','-s','5x3','-i','/input.raw'];
it('binds file map order independently of native external-pad format registration',()=>{
 const plan=planComplexVideo([...input,'-filter_complex','[0:v]scale=13:7,split[left][right]','-map','[right]','-pix_fmt','nv12','-f','rawvideo','/right.raw','-map','[left]','-pix_fmt','rgba','-f','rawvideo','/left.raw'],budget);
 expect(plan.outputs.map(output=>output.pad)).toEqual([1,0]);expect(plan.graphPlan.negotiated.nodes[1]!.outputs.map(output=>output.format)).toEqual(['rgba','rgba']);expect(plan.graphPlan.negotiated.sinks.map(output=>output.format)).toEqual(['rgba','nv12']);expect(plan.parameters.frameRate).toEqual({num:25n,den:1n});
});
it('keeps per-output sizes time options frame limits and bitexact flags scoped to their files',()=>{
 const plan=planComplexVideo(['-cpuflags','0',...input,'-lavfi','[0:v]split[left][right]','-map','[left]','-s','3x2','-ss','0.02','-t','0.05','-frames:v','1','-bitexact','-f','framecrc','/left.crc','-map','[right]','-s','13x7','-pix_fmt','nv12','-f','rawvideo','/right.raw'],budget);
 expect(plan.graphPlan.arithmetic).toBe('scalar');expect(plan.outputs[0]).toMatchObject({frames:1n,bitexact:true,time:{seek:20000n,duration:50000n}});expect(plan.outputs[1]).toMatchObject({frames:null,bitexact:false,time:{seek:0n,duration:null}});expect(plan.graphPlan.negotiated.sinks).toEqual([{format:'gray',width:3,height:2},{format:'nv12',width:13,height:7}]);for(const value of [plan.inputTime,plan.outputs[0]!.time,plan.parameters.frameRate])expect(Object.isFrozen(value)).toBe(true);
});
it('consumes duplicate external labels once each in native output binding order',()=>{
 const plan=planComplexVideo([...input,'-filter_complex','[0:v]split[x][x]','-map','[x]','-f','rawvideo','/a','-map','[x]','-f','rawvideo','/b'],budget);expect(plan.outputs.map(output=>output.pad)).toEqual([0,1]);
});
it('rejects unbound streams duplicate destinations unsupported options and insufficient budgets before I/O',()=>{
 const graph=['-filter_complex','[0:v]split[left][right]'],outputs=['-map','[left]','-f','rawvideo','/a','-map','[right]','-f','rawvideo','/b'];
 for(const argv of [[...input,...graph,'-map','[left]','-f','rawvideo','/a'],[...input,...graph,...outputs.slice(0,-1),'/a'],[...input,...graph,'-map','[left]','-f','rawvideo','/input.raw',...outputs.slice(5)],[...input,'-filter_complex','[1:v]null[left]','-map','[left]','-f','rawvideo','/a'],[...input,...graph,'-map','[left]','-c:v','copy','-f','rawvideo','/a',...outputs.slice(5)],[...input,...graph,'-map','[left]','-vf','null','-f','rawvideo','/a',...outputs.slice(5)]])expect(()=>planComplexVideo(argv,budget)).toThrow();
 expect(()=>planComplexVideo([...input,...graph,...outputs],{...budget,maxPendingPackets:1})).toThrow();expect(()=>planComplexVideo([...input,...graph,...outputs],{...budget,maxBufferBytes:4})).toThrow();
});
