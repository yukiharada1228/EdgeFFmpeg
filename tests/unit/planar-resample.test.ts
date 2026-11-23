import {expect,it} from 'vitest';
import {resampleAudio} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
function frame():AudioFrameData{const a=new Uint8Array(256),b=new Uint8Array(256);new DataView(a.buffer).setFloat32(0,1,true);new DataView(b.buffer).setFloat32(0,-1,true);return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'fltp',samples:64,planes:[a,b],pts:{value:9007199254740993n,timeBase:{num:1n,den:8000n}}};}
async function* input(...frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AudioFrameData[],rate=16000,limit=512){const result=[];for await(const value of resampleAudio(input(...frames),rate,{maxFrameBytes:limit,maxStateBytes:1024*1024}))result.push(value);return result;}
it('preserves planar output ownership origins and equal-rate bypass without interleaving scratch',async()=>{
  const source=frame(),output=await collect([source]);expect(output.map(frame=>frame.samples)).toEqual([64,64]);expect(output[0]!.pts?.value).toBe(18014398509481986n);expect(output[0]!.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);expect(output[0]!.planes[0]!.buffer).not.toBe(output[1]!.planes[0]!.buffer);expect(new DataView(output[0]!.planes[0]!.buffer).getFloat32(0,true)).toBe(1);expect(new DataView(output[0]!.planes[1]!.buffer,output[0]!.planes[1]!.byteOffset).getFloat32(0,true)).toBe(-1);
  const bypass=await collect([source],8000);expect(bypass[0]!.planes).toEqual(source.planes);expect(bypass[0]!.sampleFormat).toBe('fltp');expect(bypass[0]!.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);
});
it('rejects aggregate overflow sparse planes layout changes and non-finite planar channels',async()=>{
  await expect(collect([frame()],16000,256)).rejects.toThrow('bounded');await expect(collect([{...frame(),planes:Array<Uint8Array>(2)}])).rejects.toThrow('plane');
  const invalid=frame();new DataView(invalid.planes[1]!.buffer).setFloat32(0,NaN,true);await expect(collect([invalid])).rejects.toThrow('Non-finite');
  const second=frame();second.sampleFormat='flt';second.planes=[new Uint8Array(512)];second.pts={value:9007199254741057n,timeBase:{num:1n,den:8000n}};await expect(collect([frame(),second])).rejects.toThrow('stable');
});
