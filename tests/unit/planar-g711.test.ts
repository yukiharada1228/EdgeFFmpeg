import {expect,it} from 'vitest';
import {encodeG711} from '@edge-ffmpeg/avcodec';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
function frame():AudioFrameData{const a=new Uint8Array(9),b=new Uint8Array(9),av=new DataView(a.buffer),bv=new DataView(b.buffer);[-32768,0,32767].forEach((value,i)=>{av.setInt16(i*2+1,value,true);bv.setInt16(i*2+2,-value-(value===-32768?1:0),true);});return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:3,planes:[a.subarray(1,7),b.subarray(2,8)],pts:null};}
it('encodes direct signed16 planes without a packed allocation and keeps input owned',()=>{
  const input=frame(),before=input.planes.map(plane=>plane.slice()),result=encodeG711(input,'pcm_mulaw',{maxFrameBytes:6});expect([...result.data]).toEqual([0,128,255,255,128,0]);expect(input.planes).toEqual(before);expect(result.data.buffer).not.toBe(input.planes[0]!.buffer);expect(result.pts).toBeNull();expect(()=>encodeG711(input,'pcm_mulaw',{maxFrameBytes:5})).toThrow('allocation');
});
it('rejects sparse mis-sized and missing G711 planar input before encoding',()=>{
  for(const planes of [[],Array<Uint8Array>(2),[new Uint8Array(6),new Uint8Array(5)],[new Uint8Array(12)]])expect(()=>encodeG711({...frame(),planes},'pcm_alaw',{maxFrameBytes:6})).toThrow('plane');
  const signal=AbortSignal.abort(new Error('stop'));expect(()=>encodeG711(frame(),'pcm_mulaw',{maxFrameBytes:6,signal})).toThrow('stop');
});
