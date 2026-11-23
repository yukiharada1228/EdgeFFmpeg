import {expect,it} from 'vitest';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {encodePcm} from '@edge-ffmpeg/avcodec';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
function stereo():AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16',samples:3,planes:[new Uint8Array([0,128,255,127,255,255,1,0,0,0,2,0])],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};}
it('deinterleaves channels into bounded non-overlapping owned planes and repacks without changing timing',()=>{
  const input=stereo(),planar=convertAudioFrame(input,'s16p',{maxFrameBytes:12});expect(planar.planes.map(plane=>[...plane])).toEqual([[0,128,255,255,0,0],[255,127,1,0,2,0]]);expect(planar.pts).toEqual(input.pts);expect(planar.pts).not.toBe(input.pts);expect(planar.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
  expect(planar.planes[0]!.buffer).toBe(planar.planes[1]!.buffer);expect(planar.planes[1]!.byteOffset-planar.planes[0]!.byteOffset).toBe(6);expect(convertAudioFrame(planar,'s16',{maxFrameBytes:12}).planes).toEqual(input.planes);
  expect(encodePcm(planar,'pcm_s16le',{maxFrameBytes:12}).data).toEqual(input.planes[0]);expect(()=>convertAudioFrame(input,'dblp',{maxFrameBytes:47})).toThrow('allocation');
});
it('preserves float payload bits when packing planar subviews including NaN infinities and signed zero',()=>{
  for(const width of [4,8]){
    const data=new Uint8Array(width*8+3),view=new DataView(data.buffer,3);for(let i=0;i<8;i++){if(width===4)view.setUint32(i*4,[0x80000000,0x7fc12345,0x7f800000,0xff800000][i%4]!,true);else view.setBigUint64(i*8,[0x8000000000000000n,0x7ff8123456789abcn,0x7ff0000000000000n,0xfff0000000000000n][i%4]!,true);}
    const base=width===4?'flt':'dbl',input={...stereo(),sampleFormat:`${base}p`,samples:4,planes:[data.subarray(3,3+4*width),data.subarray(3+4*width)]},packed=convertAudioFrame(input,base,{maxFrameBytes:64}),roundtrip=convertAudioFrame(packed,`${base}p`,{maxFrameBytes:64});expect(roundtrip.planes).toEqual(input.planes);expect(roundtrip.planes[0]!.buffer).not.toBe(data.buffer);
  }
});
it('validates planar channel dimensions sparse/misaligned planes cancellation and cross-precision NaNs',()=>{
  const input=stereo();for(const planes of [[],[new Uint8Array(6)],[new Uint8Array(6),new Uint8Array(5)],Array<Uint8Array>(2)])expect(()=>convertAudioFrame({...input,sampleFormat:'s16p',planes},'flt',{maxFrameBytes:64})).toThrow('plane');
  const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>convertAudioFrame(input,'s16p',{maxFrameBytes:12,signal:controller.signal})).toThrow('stop');
  const nan=new Uint8Array(8);new DataView(nan.buffer).setFloat64(0,NaN,true);expect(()=>convertAudioFrame({...input,channels:1,samples:1,sampleFormat:'dblp',planes:[nan]},'fltp',{maxFrameBytes:8})).toThrow('NaN payload');
});
