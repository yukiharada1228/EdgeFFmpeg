import {expect,it} from 'vitest';
import {reframeAudio} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const options={maxFrameBytes:12};
function frame():AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'u8p',samples:2,planes:[new Uint8Array([1,2]),new Uint8Array([9,8])],pts:null};}
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AsyncIterable<AudioFrameData>){const result=[];for await(const value of frames)result.push(value);return result;}
it('pads each unsigned planar channel with silence and bounds total allocation',async()=>{
  const original=frame(),output=await collect(reframeAudio(input(original),3,true,options));expect(output[0]!.planes.map(plane=>[...plane])).toEqual([[1,2,128],[9,8,128]]);expect(output[0]!.planes[0]!.buffer).not.toBe(original.planes[0]!.buffer);expect(output[0]!.planes[1]!.byteOffset-output[0]!.planes[0]!.byteOffset).toBe(3);expect(output[0]!.pts).toBeNull();
  const partial=await collect(reframeAudio(input(original),3,false,options));expect(partial[0]!.planes.map(plane=>[...plane])).toEqual([[1,2],[9,8]]);expect(partial[0]!.samples).toBe(2);await expect(collect(reframeAudio(input(original),7,true,options))).rejects.toThrow('allocation');
});
it('rejects malformed planar frames and closes upstream without reading ahead',async()=>{
  for(const planes of [Array<Uint8Array>(2),[new Uint8Array(2)],[new Uint8Array(2),new Uint8Array(1)]])await expect(collect(reframeAudio(input({...frame(),planes}),3,true,options))).rejects.toThrow('Invalid');
  let produced=0,closed=0;async function* source(){try{for(let i=0;i<10;i++){produced++;yield frame();}}finally{closed++;}}
  for await(const value of reframeAudio(source(),3,true,options)){expect(value.samples).toBe(3);expect(produced).toBe(2);break;}expect(closed).toBe(1);expect(produced).toBe(2);
});
