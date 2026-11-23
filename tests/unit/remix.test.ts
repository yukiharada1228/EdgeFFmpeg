import {expect,it} from 'vitest';
import {remixAudioFrame} from '@edge-ffmpeg/swresample';
import {fusedMultiplyAdd} from '../../packages/swresample/src/fma.js';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
function frame(values:number[],channels:1|2,format:'s16'|'flt'|'dbl'='s16'):AudioFrameData{
  const width=format==='s16'?2:format==='flt'?4:8,data=new Uint8Array(values.length*width),view=new DataView(data.buffer);values.forEach((value,i)=>{if(format==='s16')view.setInt16(i*2,value,true);else if(format==='flt')view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);});
  return {sampleRate:8000,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:format,samples:values.length/channels,planes:[data],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};
}
it('normalizes integer destinations and preserves owned output metadata and signed zero',()=>{
  const input=frame([-3,0,3,0,-32768,32767],2),output=remixAudioFrame(input,1,'s16',{maxFrameBytes:64}),view=new DataView(output.planes[0]!.buffer);
  expect([view.getInt16(0,true),view.getInt16(2,true),view.getInt16(4,true)]).toEqual([-1,2,0]);expect(output.channels).toBe(1);expect(output.channelLayout).toBe('mono');expect(output.pts).toEqual(input.pts);expect(output.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
  const floating=remixAudioFrame(frame([-0],1,'dbl'),2,'dbl',{maxFrameBytes:32});expect(Object.is(new DataView(floating.planes[0]!.buffer).getFloat64(0,true),-0)).toBe(true);
});
it('reproduces explicit separate and fused scalar compiler profiles',()=>{
  const input=frame([0.734375,-0.9765625],2,'flt');
  const value=(arithmetic:'separate'|'fused')=>new DataView(remixAudioFrame(input,1,'flt',{maxFrameBytes:64,arithmetic}).planes[0]!.buffer).getFloat32(0,true);
  expect(value('separate')).toBe(-0.17125242948532104);expect(value('fused')).toBe(-0.17125239968299866);
});
it('rounds software FMA once with exact cancellation overflow subnormal and signed-zero rules',()=>{
  expect(fusedMultiplyAdd(1+2**-27,1-2**-27,-1,53)).toBe(-(2**-54));
  expect(fusedMultiplyAdd(Number.MAX_VALUE,2,-Number.MAX_VALUE,53)).toBe(Number.MAX_VALUE);expect(fusedMultiplyAdd(Number.MAX_VALUE,2,0,53)).toBe(Infinity);
  expect(fusedMultiplyAdd(Number.MIN_VALUE,0.5,Number.MIN_VALUE,53)).toBe(Number.MIN_VALUE*2);expect(fusedMultiplyAdd(Number.MIN_VALUE,0.5,0,53)).toBe(0);
  expect(Object.is(fusedMultiplyAdd(-Number.MIN_VALUE,0.5,-0,53),-0)).toBe(true);expect(Object.is(fusedMultiplyAdd(-0,1,-0,53),-0)).toBe(true);
  expect(fusedMultiplyAdd(2**-149,0.5,2**-149,24)).toBe(2**-148);expect(()=>fusedMultiplyAdd(Infinity,1,0,53)).toThrow('Finite');
});
it('rejects unknown layouts insufficient allocation non-finite inputs and cancellation',()=>{
  const input=frame([1,2],1);expect(()=>remixAudioFrame({...input,channelLayout:'1 channels'},2,'s16',{maxFrameBytes:64})).toThrow('canonical');expect(()=>remixAudioFrame(input,2,'s16',{maxFrameBytes:4})).toThrow('allocation');
  expect(()=>remixAudioFrame(frame([NaN,0],2,'flt'),1,'flt',{maxFrameBytes:64})).toThrow('Non-finite');
  const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>remixAudioFrame(input,2,'s16',{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
