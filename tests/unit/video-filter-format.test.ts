import {expect,it} from 'vitest';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
it('retains identity scale anchors while binding output format conversion to the final scaler',()=>{
 const anchored=compileVideoFilterChain('scale=13:7,scale').plan('rgb24',5,3,{outputPixelFormat:'nv12'});
 expect(anchored.stages.map(s=>[s.inputPixelFormat,s.pixelFormat,s.width,s.height])).toEqual([['rgb24','rgb24',13,7],['rgb24','nv12',13,7]]);expect(anchored.pixelFormat).toBe('nv12');expect(Object.isFrozen(anchored.stages)).toBe(true);expect(Object.isFrozen(anchored.stages[0])).toBe(true);
 const appended=compileVideoFilterChain('scale=13:7').plan('rgb24',5,3,{outputPixelFormat:'nv12',outputSize:{width:3,height:2}});expect(appended.stages.map(s=>[s.inputPixelFormat,s.pixelFormat,s.width,s.height])).toEqual([['rgb24','rgb24',13,7],['rgb24','nv12',3,2]]);
});
it('preserves intermediate format constraints and resolves implicit output format and arithmetic before execution',()=>{
 const plan=compileVideoFilterChain('format=pix_fmts=nv12,scale=13:7,format=gray,scale').plan('rgba',5,3,{arithmetic:'scalar'});
 expect(plan).toMatchObject({pixelFormat:'gray',width:13,height:7,arithmetic:'scalar'});expect(plan.stages.map(s=>[s.inputPixelFormat,s.pixelFormat,s.width,s.height])).toEqual([['rgba','nv12',5,3],['nv12','gray',13,7]]);
 const frame=decodeRawVideo({streamIndex:0,data:new Uint8Array(60),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:'rgba',width:5,height:3},{maxFrameBytes:4096});
 expect(plan.apply(frame,{maxFrameBytes:4096,maxStateBytes:plan.stateBytes}).pts).toEqual(frame.pts);expect(()=>plan.apply(frame,{maxFrameBytes:4096,maxStateBytes:plan.stateBytes-1})).toThrow('budget');expect(()=>plan.apply(frame,{maxFrameBytes:4096,arithmetic:'x86_64'})).toThrow('profile');expect(()=>plan.apply(frame,{maxFrameBytes:4096,outputPixelFormat:'rgba'})).toThrow('format');
 expect(()=>compileVideoFilterChain('null').plan('rgba',5,3).apply(frame,{maxFrameBytes:NaN})).toThrow('budget');
 expect(()=>compileVideoFilterChain('format=nv12').plan('gray',16,6,{outputPixelFormat:'rgba'})).toThrow('nondeterministic');
 const scalar=compileVideoFilterChain('format=nv12').plan('gray',16,6,{outputPixelFormat:'rgba',arithmetic:'scalar'}),gray=decodeRawVideo({streamIndex:0,data:new Uint8Array(96),pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:'gray',width:16,height:6},{maxFrameBytes:4096});expect(scalar.apply(gray,{maxFrameBytes:4096,maxStateBytes:scalar.stateBytes}).planes[0]).toHaveLength(384);
});
it('rejects unsupported format constraints and preflights expanded intermediate formats before opening files',async()=>{
 for(const text of ['format=gray|gray8','format=gray:color_ranges=pc','format=1','format=pix_fmts=unknown'])expect(()=>compileVideoFilterChain(text)).toThrow();
 expect(compileVideoFilterChain('format').plan('gray',5,3)).toMatchObject({pixelFormat:'gray',stateBytes:0,intermediateBytes:0});let opens=0;
 const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected read');},async openWrite(){opens++;throw new Error('Unexpected write');}},backend:createMediaBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:32,maxPendingPackets:2,maxCpuTimeMs:10000}}),result=await frontend.exec(['-f','rawvideo','-pixel_format','gray','-s','5x3','-i','/in','-vf','format=rgba,format=gray','-f','rawvideo','/out']);expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(opens).toBe(0);
});
