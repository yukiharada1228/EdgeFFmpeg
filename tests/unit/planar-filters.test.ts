import {expect,it} from 'vitest';
import {compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
function frame():AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:2,planes:[new Uint8Array([0,128,255,127]),new Uint8Array([255,255,1,0])],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};}
it('preserves planar metadata-only filters and negotiates owned packed volume output',()=>{
  const input=frame(),metadata=compileAudioFilterChain('anull,asetrate=11025').apply(input,{maxFrameBytes:32});expect(metadata.sampleFormat).toBe('s16p');expect(metadata.planes).toBe(input.planes);expect(metadata.pts).toEqual({value:9007199254740993n,timeBase:{num:1n,den:11025n}});
  const result=compileAudioFilterChain('volume=0.5:precision=fixed',{outputSampleFormat:'s16'}).apply(input,{maxFrameBytes:32}),view=new DataView(result.planes[0]!.buffer);expect(result.sampleFormat).toBe('s16');expect([0,2,4,6].map(offset=>view.getInt16(offset,true))).toEqual([-16384,0,16384,1]);expect(result.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
});
it('validates planar filter aggregate limits and planes before processing',()=>{
  const chain=compileAudioFilterChain('anull');expect(()=>chain.apply(frame(),{maxFrameBytes:7})).toThrow('allocation');expect(()=>chain.apply({...frame(),planes:Array<Uint8Array>(2)},{maxFrameBytes:8})).toThrow('plane');
});
