import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {resampleAudio,resampledSampleCount} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const native=resolve('.build/reference/ffmpeg');
async function edge(data:Uint8Array,inputRate:number,outputRate:number,channels:number,chunk:number){
  async function* frames():AsyncIterable<AudioFrameData>{for(let offset=0;offset<data.length;offset+=chunk*channels*8){const plane=data.slice(offset,offset+chunk*channels*8);yield {sampleRate:inputRate,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:'dbl',samples:plane.length/(channels*8),planes:[plane],pts:{value:BigInt(offset/(channels*8)),timeBase:{num:1n,den:BigInt(inputRate)}}};}}
  const output:number[]=[];let count=0n;
  for await(const frame of resampleAudio(frames(),outputRate,{maxFrameBytes:512,maxStateBytes:1024*1024})){expect(frame.pts?.value).toBe(count);expect(frame.sampleRate).toBe(outputRate);expect(frame.planes[0]!.length).toBeLessThanOrEqual(512);count+=BigInt(frame.samples);const view=new DataView(frame.planes[0]!.buffer,frame.planes[0]!.byteOffset,frame.planes[0]!.byteLength);for(let i=0;i<frame.samples*channels;i++)output.push(view.getFloat64(i*8,true));}
  return output;
}
function reference(data:Uint8Array,inputRate:number,outputRate:number,channels:number){const bytes=execFileSync(native,['-v','error','-cpuflags','0','-f','f64le','-ar',String(inputRate),'-ac',String(channels),'-i','pipe:0','-ar',String(outputRate),'-f','f64le','-'],{input:data});return Array.from({length:bytes.length/8},(_,i)=>bytes.readDoubleLE(i*8));}
it('matches default double Kaiser resampling samples and chunk invariance against scalar native FFmpeg',async()=>{
  let maximum=0;
  for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[44100,48000],[48000,44100],[16000,44100],[48000,8000]])for(const channels of [1,2]){
    const data=new Uint8Array(257*channels*8),view=new DataView(data.buffer);for(let sample=0;sample<257;sample++)for(let channel=0;channel<channels;channel++)view.setFloat64((sample*channels+channel)*8,Math.sin(sample*.123+channel)+.3*Math.cos(sample*.49-channel)+(sample===50?.5:0),true);
    const expected=reference(data,inputRate!,outputRate!,channels),actual=await edge(data,inputRate!,outputRate!,channels,7);expect(actual.length).toBe(expected.length);expect(actual).toEqual(await edge(data,inputRate!,outputRate!,channels,1));expect(actual).toEqual(await edge(data,inputRate!,outputRate!,channels,32));
    for(let i=0;i<actual.length;i++){const error=Math.abs(actual[i]!-expected[i]!);maximum=Math.max(maximum,error);expect(error,`${inputRate}->${outputRate}/${channels}/${i}`).toBeLessThanOrEqual(2e-12);}
  }
  console.info(`Default double resampling maximum absolute error: ${maximum}`);
},60000);
it('matches native short-input initialization and flush sample counts and reflected boundaries',async()=>{
  for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[44100,48000],[48000,44100],[8000,16001],[48001,44100]])for(let samples=1;samples<=80;samples++){
    const data=new Uint8Array(samples*8),view=new DataView(data.buffer);for(let i=0;i<samples;i++)view.setFloat64(i*8,(i%7-3)/4,true);
    const expected=reference(data,inputRate!,outputRate!,1),actual=await edge(data,inputRate!,outputRate!,1,7);expect(actual.length,`${inputRate}->${outputRate}/${samples}`).toBe(expected.length);expect(resampledSampleCount(BigInt(samples),inputRate!,outputRate!)).toBe(BigInt(expected.length));
    for(let i=0;i<actual.length;i++)expect(Math.abs(actual[i]!-expected[i]!),`${inputRate}->${outputRate}/${samples}/${i}`).toBeLessThanOrEqual(2e-12);
  }
},60000);

it('matches native default phase interpolation beyond 1024 rational phases including table wraparound',async()=>{
  for(const [inputRate,outputRate]of [[44100,48001],[48001,44100],[8000,16001],[16001,8000],[8000,8001]])for(const channels of [1,2]){
    const samples=1100,data=new Uint8Array(samples*channels*8),view=new DataView(data.buffer);
    for(let sample=0;sample<samples;sample++)for(let channel=0;channel<channels;channel++)view.setFloat64((sample*channels+channel)*8,(sample%19-9)/16+Math.sin(sample*.2+channel),true);
    const expected=reference(data,inputRate!,outputRate!,channels),actual=await edge(data,inputRate!,outputRate!,channels,7);expect(actual.length,`${inputRate}->${outputRate}/${channels}`).toBe(expected.length);expect(actual).toEqual(await edge(data,inputRate!,outputRate!,channels,32));
    for(let i=0;i<actual.length;i++)expect(Math.abs(actual[i]!-expected[i]!),`${inputRate}->${outputRate}/${channels}/${i}`).toBeLessThanOrEqual(2e-12);
  }
},60000);
