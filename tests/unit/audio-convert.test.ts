import { expect, it } from 'vitest';
import { convertAudioFrame } from '@edge-ffmpeg/swresample';
import type { AudioFrameData } from '@edge-ffmpeg/avutil';
function floats(values: number[]): AudioFrameData {
  const data = new Uint8Array(values.length * 8), view = new DataView(data.buffer);
  values.forEach((value,i) => view.setFloat64(i * 8,value,true));
  return { sampleRate: 8000, channels: 1, channelLayout: 'mono', sampleFormat: 'dbl', samples: values.length, planes: [data], pts: { value: 3n, timeBase: { num: 1n, den: 8000n } } };
}
it('uses scalar nearest-even rounding and signed saturation for normalized float input', () => {
  const result = convertAudioFrame(floats([-1,-1.5/32768,-0.5/32768,0.5/32768,1.5/32768,1]), 's16', { maxFrameBytes: 1024 });
  const view = new DataView(result.planes[0]!.buffer);
  expect(Array.from({length:6},(_,i) => view.getInt16(i * 2,true))).toEqual([-32768,-2,0,0,2,32767]);
  expect(result.pts).toEqual({value:3n,timeBase:{num:1n,den:8000n}});
});
it('normalizes integer amplitudes and creates independent floating output', () => {
  const frame: AudioFrameData = { ...floats([0,0,0]), sampleFormat:'u8', planes:[new Uint8Array([0,128,255])] };
  const result = convertAudioFrame(frame,'flt',{maxFrameBytes:1024});
  const view = new DataView(result.planes[0]!.buffer);
  expect([view.getFloat32(0,true),view.getFloat32(4,true),view.getFloat32(8,true)]).toEqual([-1,0,127/128]);
  result.planes[0]!.fill(0); expect([...frame.planes[0]!]).toEqual([0,128,255]);
});
it('rejects unimplemented non-finite/out-of-range integer conversion and malformed input', () => {
  for (const value of [NaN,Infinity,-Infinity,32769,-32769]) expect(() => convertAudioFrame(floats([value]),'s32',{maxFrameBytes:1024})).toThrow('runtime conversion profile');
  expect(() => convertAudioFrame(floats([NaN]),'flt',{maxFrameBytes:1024})).toThrow('NaN payload');
  expect(() => convertAudioFrame(floats([0]),'dbl',{maxFrameBytes:4})).toThrow('allocation');
  expect(() => convertAudioFrame({...floats([0]),planes:[]},'s16',{maxFrameBytes:1024})).toThrow('plane');
});

it('clips finite amplification values safely in the scalar integer profile', () => {
  const result=convertAudioFrame(floats([-32768,-2,2,32768]),'s16',{maxFrameBytes:1024});
  const view=new DataView(result.planes[0]!.buffer);
  expect(Array.from({length:4},(_,i)=>view.getInt16(i*2,true))).toEqual([-32768,-32768,32767,32767]);
});
