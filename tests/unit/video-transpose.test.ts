import {expect,it} from 'vitest';
import {transposeVideoFrame} from '@edge-ffmpeg/avfilter';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
const frame=():import('@edge-ffmpeg/avutil').VideoFrameData=>({width:3,height:2,pixelFormat:'gray',planes:[Uint8Array.of(1,2,3,4,5,6)],linesizes:[3],pts:null,metadata:{}});
it('rejects invalid storage budgets directions and non-symmetric chroma before allocating',()=>{
 for(const maxFrameBytes of [0,5,NaN,Infinity])expect(()=>transposeVideoFrame(frame(),1,{maxFrameBytes})).toThrow();
 for(const direction of [-1,4,NaN])expect(()=>transposeVideoFrame(frame(),direction as 0,{maxFrameBytes:64})).toThrow();
 for(const linesizes of [[2],[-3],[]])expect(()=>transposeVideoFrame({...frame(),linesizes},1,{maxFrameBytes:64})).toThrow();
 expect(()=>transposeVideoFrame({...frame(),pixelFormat:'yuv422p'},1,{maxFrameBytes:64})).toThrow();
 expect(()=>transposeVideoFrame({...frame(),planes:[new Uint8Array(65)]},1,{maxFrameBytes:64})).toThrow();
 expect(()=>transposeVideoFrame(frame(),1,{maxFrameBytes:64,signal:AbortSignal.abort()})).toThrow();
});
it('inverts four rotations without changing input ownership or timestamp precision',()=>{
 const source=frame(),before=source.planes[0]!.slice();let current=source;
 for(let i=0;i<4;i++)current=transposeVideoFrame(current,1,{maxFrameBytes:64});
 expect(current.planes[0]).toEqual(before);expect(source.planes[0]).toEqual(before);expect(current.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);
});
it('resolves legacy directions and geometry passthrough at each graph boundary',()=>{
 for(const [width,height]of [[5,3],[3,5],[4,4]])for(const direction of [0,1,2,3,4,5,6,7])for(const passthrough of [0,1,2,3]){
 const plan=compileVideoFilterChain(`transpose=${direction}:passthrough=${passthrough}`).plan('gray',width!,height!);const mode=direction&4?1:passthrough,skip=mode===1&&width!>=height!||mode===2&&width!<=height!;
 expect([plan.width,plan.height]).toEqual(skip?[width,height]:[height,width]);
 }
 expect(compileVideoFilterChain('transpose=clock,transpose=cclock').plan('gray',5,3)).toMatchObject({width:5,height:3});
});
it('retains the full user-node allowance with implicit input trim and output sizing',()=>{
 const plan=compileVideoFilterChain(Array(32).fill('transpose=clock').join(',')).plan('gray',5,3,{inputTrim:true,outputSize:{width:3,height:2}});
 expect([plan.width,plan.height]).toEqual([3,2]);expect(plan.stages.filter(stage=>stage.operation==='transpose')).toHaveLength(32);
 expect(()=>compileVideoFilterChain(Array(33).fill('transpose').join(','))).toThrow();
});
