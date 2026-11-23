import {expect,it} from 'vitest';
import {decodeG711,encodeG711,decodePcm,encodePcm,getPcmFormat} from '@edge-ffmpeg/avcodec';
import type {G711Codec} from '@edge-ffmpeg/avcodec';
import type {MediaPacket,AudioFrameData} from '@edge-ffmpeg/avutil';
function packet(data:number[]):MediaPacket{return {streamIndex:0,data:new Uint8Array(data),pts:9007199254740993n,dts:9007199254740993n,duration:BigInt(data.length),timeBase:{num:1n,den:8000n},flags:1};}
it('decodes companded samples into owned signed16 frames and canonicalizes mu-law zero on re-encode',()=>{
  const input=packet([0,128,127,255,254,126]),format={codec:'pcm_mulaw',channels:2,sampleRate:8000} as const;
  const decoded=decodeG711(input,format,{maxFrameBytes:64}),view=new DataView(decoded.planes[0]!.buffer);expect(Array.from({length:6},(_,i)=>view.getInt16(i*2,true))).toEqual([-32124,32124,0,0,8,-8]);expect(decoded.samples).toBe(3);expect(decoded.pts?.value).toBe(9007199254740993n);
  expect(decoded.planes[0]!.buffer).not.toBe(input.data.buffer);expect([...encodeG711(decoded,'pcm_mulaw',{maxFrameBytes:64}).data]).toEqual([0,128,255,255,254,126]);expect([...input.data]).toEqual([0,128,127,255,254,126]);
  expect(getPcmFormat('pcm_alaw')).toEqual({bytesPerSample:1,frameBytesPerSample:2,sampleFormat:'s16'});expect(decodePcm(input,format,{maxFrameBytes:64}).planes[0]).toEqual(decoded.planes[0]);
});
it('retains packed plane offsets and rational bigint PTS in A-law encoding',()=>{
  const storage=new Uint8Array(12),plane=storage.subarray(2,10),view=new DataView(plane.buffer,plane.byteOffset,plane.length);[-8,8,-32256,32256].forEach((value,i)=>view.setInt16(i*2,value,true));
  const frame:AudioFrameData={sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:4,planes:[plane],pts:{value:9n,timeBase:{num:1n,den:16000n}}};
  const encoded=encodePcm(frame,'pcm_alaw',{maxFrameBytes:64});expect([...encoded.data]).toEqual([0x55,0xd5,0x2a,0xaa]);expect(encoded.pts).toBe(5n);expect(encoded.duration).toBe(4n);expect(storage.subarray(0,2)).toEqual(new Uint8Array(2));
});
it('rejects invalid codec alignment allocation planes time bases and cancellation',()=>{
  const format={codec:'pcm_alaw',channels:1,sampleRate:8000} as const,options={maxFrameBytes:16};
  expect(()=>decodeG711(packet([1,2,3]),{...format,channels:2},options)).toThrow('alignment');
  expect(()=>decodeG711(packet([1,2,3]),format,{maxFrameBytes:4})).toThrow('allocation');
  expect(()=>decodeG711({...packet([1]),timeBase:{num:1n,den:0n}},format,options)).toThrow('time base');
  expect(()=>decodeG711(packet([1]),{...format,codec:'__proto__' as G711Codec},options)).toThrow('codec');
  const frame=decodeG711(packet([1,2]),format,options);expect(()=>encodeG711({...frame,planes:[new Uint8Array(1)]},'pcm_alaw',options)).toThrow('packed');
  const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>encodeG711(frame,'pcm_mulaw',{...options,signal:controller.signal})).toThrow('stop');
});
