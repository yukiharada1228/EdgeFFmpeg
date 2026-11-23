import {it,expect} from 'vitest';
import {planMultiVideo} from '../../packages/avformat/src/multi-video-plan.js';
const budget={maxResidentBytes:1048576,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000};
const input=(path:string,size='2x2',rate='25')=>['-f','rawvideo','-pixel_format','gray','-s',size,'-framerate',rate,'-i',path];
const output=['-map','[o]','-f','rawvideo','/out'];
it('keeps independent input scopes and canonical graph-pad binding order',()=>{
 const plan=planMultiVideo(['-ss','0.02',...input('/a','2x2','50/2'),'-t','0.08',...input('/b','3x2','30'),'-filter_complex','[1:v][0:v]hstack[o]',...output],budget);
 expect(plan.bindings).toEqual([1,0]);expect(plan.sources.map(source=>source.parameters.frameRate)).toEqual([{num:25n,den:1n},{num:30n,den:1n}]);expect(plan.sources.map(source=>source.time)).toEqual([{seek:20000n,duration:null,stop:null},{seek:0n,duration:80000n,stop:null}]);expect(plan.graphPlan.negotiated.sinks[0]).toEqual({format:'gray',width:5,height:2});expect(plan.requiredPayloadBytes).toBeLessThan(BigInt(budget.maxResidentBytes));
});
it('binds unlabeled pads to unused physical inputs and allows explicit stream reuse',()=>{
 const implicit=planMultiVideo([...input('/a'),...input('/b'),'-filter_complex','hstack[o]',...output],budget);expect(implicit.bindings).toEqual([0,1]);
 const reused=planMultiVideo([...input('/a'),'-filter_complex','[0:v][0:v]hstack[o]',...output],budget);expect(reused.bindings).toEqual([0,0]);expect(reused.sourceTraversals).toBe(2);
});
it('maps outputs independently from external-pad order with independent output limits',()=>{
 const plan=planMultiVideo([...input('/a'),...input('/b'),'-filter_complex','[0:v][1:v]hstack,split[left][right]','-map','[right]','-frames:v','2','-f','rawvideo','/right','-map','[left]','-t','0.05','-f','framecrc','/left'],budget);
 expect(plan.outputs.map(output=>output.pad)).toEqual([1,0]);expect(plan.outputs[0]?.frames).toBe(2n);expect(plan.outputs[1]?.time.duration).toBe(50000n);expect(plan.sourceTraversals).toBe(4);
});
it('rejects stream index errors and path collisions during planning',()=>{
 for(const description of ['[2:v][0:v]hstack[o]','[0:a][1:v]hstack[o]'])expect(()=>planMultiVideo([...input('/a'),...input('/b'),'-filter_complex',description,...output],budget)).toThrow();
 expect(()=>planMultiVideo([...input('/a'),...input('/b'),'-filter_complex','hstack[o]','-map','[o]','-f','rawvideo','/a'],budget)).toThrow(/distinct/);
});
it('preflights aggregate graph and output payloads before any source is opened',()=>{
 expect(()=>planMultiVideo([...input('/a','256x256'),...input('/b','256x256'),'-filter_complex','hstack[o]',...output],budget)).toThrow(/budget/);
 expect(()=>planMultiVideo([...input('/a'),...input('/b'),'-filter_complex','hstack,split[x][y]','-map','[x]','-f','rawvideo','/x','-map','[y]','-f','rawvideo','/y'],{...budget,maxPendingPackets:1})).toThrow(/queues/);
});
