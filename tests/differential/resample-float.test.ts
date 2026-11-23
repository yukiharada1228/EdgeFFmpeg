import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {resampleAudio,resampledSampleCount} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const native=resolve('.build/reference/ffmpeg');
async function edge(data:Uint8Array,inputRate:number,outputRate:number,channels:number,chunk:number){
  async function* frames():AsyncIterable<AudioFrameData>{for(let offset=0;offset<data.length;offset+=chunk*channels*4){const plane=data.slice(offset,offset+chunk*channels*4);yield {sampleRate:inputRate,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:'flt',samples:plane.length/(channels*4),planes:[plane],pts:{value:BigInt(offset/(channels*4)),timeBase:{num:1n,den:BigInt(inputRate)}}};}}
  const output:number[]=[];let count=0n;
  for await(const frame of resampleAudio(frames(),outputRate,{maxFrameBytes:512,maxStateBytes:1024*1024})){expect(frame.pts?.value).toBe(count);expect(frame.sampleFormat).toBe('flt');count+=BigInt(frame.samples);const plane=frame.planes[0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);for(let i=0;i<frame.samples*channels;i++)output.push(view.getFloat32(i*4,true));}
  return output;
}
function reference(data:Uint8Array,inputRate:number,outputRate:number,channels:number){const bytes=execFileSync(native,['-v','error','-cpuflags','0','-f','f32le','-ar',String(inputRate),'-ac',String(channels),'-i','pipe:0','-ar',String(outputRate),'-f','f32le','-'],{input:data});return Array.from({length:bytes.length/4},(_,i)=>bytes.readFloatLE(i*4));}
it('matches scalar native float FIR samples with exact rational phases and partition invariance',async()=>{
  for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[44100,48000],[48000,44100],[16000,44100],[48000,8000]])for(const channels of [1,2]){
    const data=new Uint8Array(257*channels*4),view=new DataView(data.buffer);for(let i=0;i<257*channels;i++)view.setFloat32(i*4,Math.sin(i*.123)+.3*Math.cos(i*.49),true);
    const actual=await edge(data,inputRate!,outputRate!,channels,7),expected=reference(data,inputRate!,outputRate!,channels);expect(actual.length).toBe(expected.length);for(let i=0;i<actual.length;i++)expect(Math.abs(actual[i]!-expected[i]!),`${inputRate}->${outputRate}/${channels}/${i}`).toBeLessThanOrEqual(1e-6);expect(actual).toEqual(await edge(data,inputRate!,outputRate!,channels,1));expect(actual).toEqual(await edge(data,inputRate!,outputRate!,channels,32));
  }
},60000);
it('matches native float interpolation and finite short-input flush within declared numerical tolerance',async()=>{
  for(const [inputRate,outputRate]of [[8000,16001],[48001,44100],[44100,48001]])for(const samples of [1,21,24,42,65,1100])for(const channels of [1,2]){
    const data=new Uint8Array(samples*channels*4),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++)view.setFloat32(i*4,(i%19-9)/16+Math.sin(i*.2),true);
    const expected=reference(data,inputRate!,outputRate!,channels),actual=await edge(data,inputRate!,outputRate!,channels,7);expect(actual.length).toBe(expected.length);expect(BigInt(actual.length/channels)).toBe(resampledSampleCount(BigInt(samples),inputRate!,outputRate!));expect(actual).toEqual(await edge(data,inputRate!,outputRate!,channels,32));
    for(let i=0;i<actual.length;i++)expect(Math.abs(actual[i]!-expected[i]!),`${inputRate}->${outputRate}/${samples}/${channels}/${i}`).toBeLessThanOrEqual(1e-6);
  }
},60000);
