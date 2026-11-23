import {expect,it} from 'vitest';
import {decodePcm,encodePcm,getPcmFormat,isIntegerPcm,isPcmCodec} from '@edge-ffmpeg/avcodec';
import {rawPcmCodec,supportsWavCodec} from '@edge-ffmpeg/containers';
import type {PcmCodec,MediaPacket} from '@edge-ffmpeg/avutil';
function packet(data:number[]):MediaPacket{return {streamIndex:0,data:new Uint8Array(data),pts:9007199254740993n,dts:9007199254740993n,duration:null,timeBase:{num:1n,den:8000n},flags:1};}
it('decodes signed8 and unsigned big-endian bias into owned native packed frames',()=>{
  const examples:[PcmCodec,number[],number[]][]=[
    ['pcm_s8',[0,127,128,255],[128,255,0,127]],
    ['pcm_u16be',[0,0,128,0,255,255],[-32768,0,32767]],
    ['pcm_u24be',[0,0,0,128,0,0,255,255,255],[-2147483648,0,2147483392]],
    ['pcm_u32be',[0,0,0,0,128,0,0,0,255,255,255,255],[-2147483648,0,2147483647]]
  ];
  for(const [codec,bytes,expected]of examples){
    const input=packet(bytes),frame=decodePcm(input,{codec,channels:1,sampleRate:8000},{maxFrameBytes:128}),plane=frame.planes[0]!,view=new DataView(plane.buffer),width=plane.length/frame.samples;
    expect(Array.from({length:frame.samples},(_,i)=>width===1?view.getUint8(i):width===2?view.getInt16(i*2,true):view.getInt32(i*4,true))).toEqual(expected);
    expect(encodePcm(frame,codec,{maxFrameBytes:128}).data).toEqual(input.data);expect(plane.buffer).not.toBe(input.data.buffer);expect(frame.pts?.value).toBe(9007199254740993n);
  }
});
it('exposes matching codec/raw registries and rejects unsupported WAV representations',()=>{
  for(const name of ['s8','s16be','s24be','s32be','u16le','u16be','u24le','u24be','u32le','u32be','f32be','f64be']){
    const codec=`pcm_${name}`;expect(isPcmCodec(codec)).toBe(true);expect(rawPcmCodec(name)).toBe(codec);expect(supportsWavCodec(codec)).toBe(false);
  }
  expect(isIntegerPcm('pcm_f32be')).toBe(false);expect(isIntegerPcm('pcm_f64be')).toBe(false);expect(isIntegerPcm('pcm_u32be')).toBe(true);expect(getPcmFormat('pcm_s8')).toEqual({bytesPerSample:1,frameBytesPerSample:1,sampleFormat:'u8'});expect(isPcmCodec('__proto__')).toBe(false);
});
it('rejects incomplete endian words and bounds 24-bit expansion',()=>{
  expect(()=>decodePcm(packet([1,2]),{codec:'pcm_s24be',channels:1,sampleRate:8000},{maxFrameBytes:32})).toThrow('alignment');
  expect(()=>decodePcm(packet(Array(9).fill(0)),{codec:'pcm_u24le',channels:1,sampleRate:8000},{maxFrameBytes:9})).toThrow('allocation');
});
