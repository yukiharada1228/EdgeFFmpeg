import {expect,it} from 'vitest';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
it('preflights intermediate video frames and preserves exact timestamps across sequential scales',()=>{
 const plan=compileVideoFilterChain('null,scale=13:7,scale=2:2').plan('gray',5,3),input=decodeRawVideo({streamIndex:0,data:new Uint8Array(15).fill(73),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:'gray',width:5,height:3},{maxFrameBytes:128});
 expect(plan).toMatchObject({width:2,height:2,maxFrameBytes:91,intermediateBytes:95});const output=plan.apply(input,{maxFrameBytes:128,maxStateBytes:plan.stateBytes});expect(output.pts).toEqual(input.pts);expect(output.planes[0]).toEqual(new Uint8Array(4).fill(73));expect(output.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
 expect(()=>plan.apply(input,{maxFrameBytes:90,maxStateBytes:plan.stateBytes})).toThrow('budget');expect(()=>plan.apply(input,{maxFrameBytes:128,maxStateBytes:plan.stateBytes-1})).toThrow('budget');expect(()=>plan.apply({...input,width:3},{maxFrameBytes:128,maxStateBytes:plan.stateBytes})).toThrow('input');expect(()=>plan.apply(input,{maxFrameBytes:128,maxStateBytes:plan.stateBytes,signal:AbortSignal.abort(new Error('stop'))})).toThrow('stop');
});
it('rejects unimplemented video graphs expressions kernels and excessive node counts',()=>{
 for(const text of ['','scale=iw/2:ih/2','scale=2:2:flags=neighbor','scale=w=2','scale=2:-1','null;null','[in][other]null[out]',Array(33).fill('null').join(',')])expect(()=>compileVideoFilterChain(text),text).toThrow();
 expect(()=>compileVideoFilterChain('scale=2:2').plan('unknown',5,3)).toThrow();expect(compileVideoFilterChain('null,scale').plan('rgb24',5,3)).toMatchObject({width:5,height:3,stateBytes:0});
});
it('rejects unsupported copy filtering and intermediate graph budget overflow before I/O',async()=>{
 for(const after of [['-c:v','copy','-vf','null'],['-vf','scale=100:100,scale=2:2'],['-vf','scale=iw:ih']]){
  let opens=0;const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected read');},async openWrite(){opens++;throw new Error('Unexpected write');}},backend:createMediaBackend(),budget:{maxResidentBytes:4096,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:10000}});
  const result=await frontend.exec(['-f','rawvideo','-pixel_format','gray','-s','5x3','-i','/in',...after,'-f','rawvideo','/out']);expect(result.exitCode).not.toBe(0);expect(opens).toBe(0);
 }
});
