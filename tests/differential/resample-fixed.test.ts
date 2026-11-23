import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {resampleAudio} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const native=resolve('.build/reference/ffmpeg');
async function edge(data:Uint8Array,inputRate:number,outputRate:number,channels:number,chunk:number){
  async function* frames():AsyncIterable<AudioFrameData>{for(let offset=0;offset<data.length;offset+=chunk*channels*2){const plane=data.slice(offset,offset+chunk*channels*2);yield {sampleRate:inputRate,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:'s16',samples:plane.length/(channels*2),planes:[plane],pts:{value:BigInt(offset/(channels*2)),timeBase:{num:1n,den:BigInt(inputRate)}}};}}
  const chunks:Buffer[]=[];let count=0n;
  for await(const frame of resampleAudio(frames(),outputRate,{maxFrameBytes:512,maxStateBytes:1024*1024})){expect(frame.pts?.value).toBe(count);expect(frame.sampleFormat).toBe('s16');count+=BigInt(frame.samples);chunks.push(Buffer.from(frame.planes[0]!));}
  return Buffer.concat(chunks);
}
function reference(data:Uint8Array,inputRate:number,outputRate:number,channels:number){return execFileSync(native,['-v','error','-cpuflags','0','-f','s16le','-ar',String(inputRate),'-ac',String(channels),'-i','pipe:0','-af',`aresample=${outputRate}:tsf=s16p`,'-f','s16le','-'],{input:data,maxBuffer:4*1024*1024});}
it('matches forced native signed16 FIR quantization saturation interpolation and partition invariance',async()=>{
  for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[44100,48000],[48000,44100],[8000,16001],[48001,44100]])for(const channels of [1,2]){
    const data=new Uint8Array(257*channels*2),view=new DataView(data.buffer);for(let i=0;i<257*channels;i++)view.setInt16(i*2,i%7===0?32767:i%11===0?-32768:(i*3137)%65536-32768,true);
    const expected=reference(data,inputRate!,outputRate!,channels),actual=await edge(data,inputRate!,outputRate!,channels,7);expect(actual.equals(expected),`${inputRate}->${outputRate}/${channels}`).toBe(true);expect(actual).toEqual(await edge(data,inputRate!,outputRate!,channels,1));expect(actual).toEqual(await edge(data,inputRate!,outputRate!,channels,32));
  }
},60000);
it('matches native fixed FIR over every signed16 input value in a finite full-domain stream',async()=>{
  const data=new Uint8Array(65536*2),view=new DataView(data.buffer);for(let i=0;i<65536;i++)view.setInt16(i*2,i-32768,true);
  expect(await edge(data,8000,16000,1,128)).toEqual(reference(data,8000,16000,1));
},60000);

it('matches native fixed signed16 finite short-input draining and reflected boundaries',async()=>{
  for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[8000,16001],[48001,44100]])for(const samples of [1,21,22,24,32,33,42,65]){
    const data=new Uint8Array(samples*2),view=new DataView(data.buffer);for(let i=0;i<samples;i++)view.setInt16(i*2,i%3===0?-32768:i%3===1?32767:0,true);
    expect(await edge(data,inputRate!,outputRate!,1,7),`${inputRate}->${outputRate}/${samples}`).toEqual(reference(data,inputRate!,outputRate!,1));
  }
},30000);
