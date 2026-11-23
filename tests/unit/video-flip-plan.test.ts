import {expect,it} from 'vitest';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
it('retains flip operations and accounts for each owned intermediate frame without coefficient workspace',()=>{
 const plan=compileVideoFilterChain('hflip,vflip,hflip,vflip').plan('gray',5,3);
 expect(plan.stages.map(stage=>stage.operation)).toEqual(['hflip','vflip','hflip','vflip']);expect(plan.stateBytes).toBe(0);expect(plan.intermediateBytes).toBe(60);expect(plan.maxFrameBytes).toBe(15);expect(Object.isFrozen(plan.stages)).toBe(true);for(const stage of plan.stages)expect(Object.isFrozen(stage)).toBe(true);
 const input=Uint8Array.from({length:15},(_,index)=>index),frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:'gray',width:5,height:3},{maxFrameBytes:15}),actual=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect(actual.planes[0]).toEqual(input);expect(actual.planes[0]).not.toBe(frame.planes[0]);expect(actual.pts).toEqual(frame.pts);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
});
it('keeps resize anchors and arithmetic guards around reflected frames',()=>{
 const plan=compileVideoFilterChain('hflip,scale=13:7,vflip').plan('rgba',5,3,{outputPixelFormat:'nv12',outputSize:{width:3,height:2}});
 expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat,stage.width,stage.height])).toEqual([['hflip','rgba',5,3],['scale','rgba',13,7],['vflip','rgba',13,7],['scale','nv12',3,2]]);
 expect(()=>compileVideoFilterChain('format=nv12,hflip').plan('gray',16,6,{outputPixelFormat:'rgba'})).toThrow('nondeterministic');expect(compileVideoFilterChain('format=nv12,hflip').plan('gray',16,6,{outputPixelFormat:'rgba',arithmetic:'scalar'}).pixelFormat).toBe('rgba');
});
it('rejects unsupported reflection options instead of dropping timeline expressions',()=>{
 for(const description of ['hflip=1','vflip=enable=1','hflip=enable=between(t,1,2)','hflip[a][b]'])expect(()=>compileVideoFilterChain(description)).toThrow();
});
