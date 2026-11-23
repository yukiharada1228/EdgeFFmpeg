import {expect,it} from 'vitest';
import {convertAudioFrame,remixAudioFrame,remixInternalFormat} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
function frame():AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:3,planes:[new Uint8Array([253,255,3,0,0,128]),new Uint8Array([0,0,0,0,255,127])],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};}
it('normalizes planar precision selection and preserves integer rounding owned planes and PTS',()=>{
  expect(remixInternalFormat('dblp','s16p')).toBe('dbl');expect(remixInternalFormat('u8p','s16')).toBe('s16');expect(remixInternalFormat('s32p','s16p')).toBe('flt');
  const input=frame(),output=remixAudioFrame(input,1,'s16p',{maxFrameBytes:12}),view=new DataView(output.planes[0]!.buffer);expect([view.getInt16(0,true),view.getInt16(2,true),view.getInt16(4,true)]).toEqual([-1,2,0]);expect(output.sampleFormat).toBe('s16p');expect(output.channelLayout).toBe('mono');expect(output.pts).toEqual(input.pts);expect(output.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
  const same=remixAudioFrame(input,2,'s16',{maxFrameBytes:12});expect(same.planes).toEqual(convertAudioFrame(input,'s16',{maxFrameBytes:12}).planes);
});
it('bounds aggregate planar upmix and preserves signed zero with disjoint channel views',()=>{
  const data=new Uint8Array(8);new DataView(data.buffer).setFloat64(0,-0,true);const input={...frame(),channels:1,channelLayout:'mono',samples:1,sampleFormat:'dblp',planes:[data]},output=remixAudioFrame(input,2,'dblp',{maxFrameBytes:16});for(const plane of output.planes)expect(Object.is(new DataView(plane.buffer,plane.byteOffset).getFloat64(0,true),-0)).toBe(true);expect(output.planes[1]!.byteOffset-output.planes[0]!.byteOffset).toBe(8);expect(()=>remixAudioFrame(input,2,'dblp',{maxFrameBytes:15})).toThrow('allocation');
  expect(()=>remixAudioFrame({...frame(),planes:Array<Uint8Array>(2)},1,'s16p',{maxFrameBytes:12})).toThrow('plane');
});
