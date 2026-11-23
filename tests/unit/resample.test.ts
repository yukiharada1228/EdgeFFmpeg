import {expect,it} from 'vitest';
import {resampleAudio,resampleInternalFormat,planAudioResample,resampledSampleCount} from '@edge-ffmpeg/swresample';
import type {AudioResampleOptions} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const options={maxFrameBytes:512,maxStateBytes:1024*1024};
function frame(samples=64,pts:bigint|null=0n):AudioFrameData{const data=new Uint8Array(samples*8);new DataView(data.buffer).setFloat64(0,1,true);return {sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'dbl',samples,planes:[data],pts:pts===null?null:{value:pts,timeBase:{num:1n,den:8000n}}};}
async function* input(frames:AudioFrameData[]){yield*frames;}
async function collect(frames:AudioFrameData[],rate=16000,limits:AudioResampleOptions=options){const result=[];for await(const out of resampleAudio(input(frames),rate,limits))result.push(out);return result;}
it('plans bounded FIR payloads and counts native initialization and finite flush output',()=>{
  const plan=planAudioResample(8000,16000,2,options);expect(plan).toEqual({inputRate:8000,outputRate:16000,channels:2,sampleFormat:'dbl',taps:32,phases:2,interpolates:false,historySamples:66,coefficientBytes:512,stateBytes:1568});expect(Object.isFrozen(plan)).toBe(true);
  expect(resampledSampleCount(21n,8000,16000)).toBe(0n);expect(resampledSampleCount(24n,8000,16000)).toBe(40n);expect(resampledSampleCount(42n,48000,44100)).toBe(38n);expect(resampledSampleCount(9007199254740993n,8000,16000)).toBe(18014398509481986n);
  expect(planAudioResample(44100,48001,1,options)).toMatchObject({phases:1024,interpolates:true,coefficientBytes:262144});expect(()=>planAudioResample(48000,8000,2,{...options,maxStateBytes:64})).toThrow('state');expect(()=>planAudioResample(8000,16000,2,{...options,maxFrameBytes:8})).toThrow('limits');expect(()=>resampledSampleCount(-1n,8000,16000)).toThrow('count');
});
it('preserves bigint sample origins and independent owned output including equal-rate bypass',async()=>{
  const source=frame(64,9007199254740993n),result=await collect([source]);expect(result[0]!.pts?.value).toBe(18014398509481986n);expect(result.map(out=>out.samples)).toEqual([64,64]);expect(result[1]!.pts?.value).toBe(18014398509482050n);expect(result[0]!.planes[0]!.buffer).not.toBe(result[1]!.planes[0]!.buffer);expect(result[0]!.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);
  const same=await collect([source],8000);expect(same[0]!.planes[0]).toEqual(source.planes[0]);expect(same[0]!.planes[0]!.buffer).not.toBe(source.planes[0]!.buffer);expect(same[0]!.pts).toEqual(source.pts);
  const unknown=await collect([frame(64,null)]);expect(unknown.every(out=>out.pts===null)).toBe(true);expect(await collect([])).toEqual([]);
});
it('rejects discontinuous timestamps changing formats non-finite planes and cancellation',async()=>{
  await expect(collect([frame(32),frame(32,33n)])).rejects.toThrow('contiguous');await expect(collect([{...frame(),sampleFormat:'u8'}])).rejects.toThrow('s16/flt/dbl');
  const invalid=frame();new DataView(invalid.planes[0]!.buffer).setFloat64(0,NaN,true);await expect(collect([invalid])).rejects.toThrow('Non-finite');
  const controller=new AbortController();controller.abort(new Error('stop'));let read=false;async function* source(){read=true;yield frame();}
  await expect((async()=>{for await(const out of resampleAudio(source(),16000,{...options,signal:controller.signal}))void out;})()).rejects.toThrow('stop');expect(read).toBe(false);
});
it('plans four-byte float state and infers frame precision without widening buffers',async()=>{
  const limits={maxFrameBytes:128,maxStateBytes:1024,sampleFormat:'flt' as const},plan=planAudioResample(8000,16000,1,limits);expect(plan).toMatchObject({sampleFormat:'flt',coefficientBytes:256,stateBytes:520});
  const data=new Uint8Array(128);new DataView(data.buffer).setFloat32(0,1,true);const source={...frame(32),sampleFormat:'flt',planes:[data]},result=await collect([source],16000,limits);expect(result.map(out=>out.samples)).toEqual([32,32]);expect(result.every(out=>out.sampleFormat==='flt'&&out.planes[0]!.length===128)).toBe(true);expect(result[0]!.planes[0]!.buffer).not.toBe(data.buffer);expect(new DataView(result[0]!.planes[0]!.buffer).getFloat32(0,true)).toBe(1);
  await expect(collect([source],16000,{...options,sampleFormat:'dbl'})).rejects.toThrow('s16/flt/dbl');
});

it('selects native fixed and floating internal profiles and bounds signed16 state',async()=>{
  expect(resampleInternalFormat('u8','s16')).toBe('s16');expect(resampleInternalFormat('s16','u8')).toBe('s16');expect(resampleInternalFormat('s16','s16')).toBe('flt');expect(resampleInternalFormat('s32','s16')).toBe('flt');expect(resampleInternalFormat('dbl','u8')).toBe('dbl');
  const limits={maxFrameBytes:64,maxStateBytes:512,sampleFormat:'s16' as const};expect(planAudioResample(8000,16000,1,limits)).toMatchObject({sampleFormat:'s16',coefficientBytes:128,stateBytes:260});
  const data=new Uint8Array(64);new DataView(data.buffer).setInt16(0,32767,true);const result=await collect([{...frame(32),sampleFormat:'s16',planes:[data]}],16000,limits);expect(result.map(frame=>frame.samples)).toEqual([32,32]);expect(new DataView(result[0]!.planes[0]!.buffer).getInt16(0,true)).toBe(32766);expect(result[0]!.sampleFormat).toBe('s16');expect(result[0]!.planes[0]!.buffer).not.toBe(data.buffer);
});
