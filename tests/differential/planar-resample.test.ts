import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {convertAudioFrame,resampleAudio} from '@edge-ffmpeg/swresample';
import type {ResampleSampleFormat,PlanarSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
it('matches native planar FIR processing across precision channels rates short tails and partitions',async()=>{
  const formats:[ResampleSampleFormat,string,number][]=[['s16','s16le',2],['flt','f32le',4],['dbl','f64le',8]];
  for(const [format,raw,width]of formats)for(const channels of [1,2,6])for(const [inputRate,outputRate]of [[8000,16000],[48001,44100]])for(const samples of [24,65,257]){
    const data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++){const value=Math.sin(i*.123)+.2*Math.cos(i*.49);if(width===2)view.setInt16(i*2,(i*3137)%65536-32768,true);else if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}
    const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar',String(inputRate),'-ac',String(channels),'-i','pipe:0','-af',`aformat=sample_fmts=${format}p,aresample=${outputRate}:tsf=${format}p`,'-f',raw,'-'],{input:data});
    let previous:Buffer|undefined;
    for(const chunk of [1,7,16]){
      async function* frames():AsyncIterable<AudioFrameData>{for(let offset=0;offset<samples;offset+=chunk){const count=Math.min(chunk,samples-offset);yield convertAudioFrame({sampleRate:inputRate!,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'5.1',sampleFormat:format,samples:count,planes:[data.slice(offset*channels*width,(offset+count)*channels*width)],pts:{value:BigInt(offset),timeBase:{num:1n,den:BigInt(inputRate!)}}},`${format}p` as PlanarSampleFormat,{maxFrameBytes:1024});}}
      let count=0n;const chunks:Buffer[]=[];for await(const frame of resampleAudio(frames(),outputRate!,{maxFrameBytes:1024,maxStateBytes:2*1024*1024,sampleFormat:format})){expect(frame.sampleFormat).toBe(`${format}p`);expect(frame.pts?.value).toBe(count);expect(frame.planes).toHaveLength(channels);expect(frame.planes.reduce((sum,plane)=>sum+plane.length,0)).toBeLessThanOrEqual(1024);count+=BigInt(frame.samples);chunks.push(Buffer.from(convertAudioFrame(frame,format,{maxFrameBytes:1024}).planes[0]!));}
      const actual=Buffer.concat(chunks);expect(actual.length,`${format}/${channels}/${inputRate}/${samples}`).toBe(expected.length);if(previous)expect(actual).toEqual(previous);previous=actual;
      if(width===2)expect(actual).toEqual(expected);else for(let i=0;i<actual.length/width;i++)expect(Math.abs((width===4?actual.readFloatLE(i*4):actual.readDoubleLE(i*8))-(width===4?expected.readFloatLE(i*4):expected.readDoubleLE(i*8)))).toBeLessThanOrEqual(width===4?1e-6:2e-12);
    }
  }
},60000);
