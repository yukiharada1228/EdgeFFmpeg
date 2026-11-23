import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {PlanarSampleFormat,PackedSampleFormat} from '@edge-ffmpeg/swresample';
import {reframeAudio} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
it('matches native planar FIFO padding samples and timestamps across formats channels and input partitions',async()=>{
  const formats:[PackedSampleFormat,string,number][]=[['u8','u8',1],['s16','s16le',2],['s32','s32le',4],['flt','f32le',4],['dbl','f64le',8]];
  for(const [format,raw,width]of formats)for(const channels of [1,2,6])for(const pad of [false,true]){
    const samples=23,data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++){if(format==='u8')view.setUint8(i,(i*37)&255);else if(format==='s16')view.setInt16(i*2,(i*3137)%65536-32768,true);else if(format==='s32')view.setInt32(i*4,Math.imul(i+1,2654435761),true);else if(format==='flt')view.setFloat32(i*4,(i%37-18)/16,true);else view.setFloat64(i*8,(i%37-18)/16,true);}
    const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels),'-i','pipe:0','-af',`aformat=sample_fmts=${format}p,asetnsamples=7:p=${pad?1:0}`,'-f',raw,'-'],{input:data});
    for(const chunk of [1,5,23]){
      async function* input():AsyncIterable<AudioFrameData>{for(let offset=0;offset<samples;offset+=chunk){const count=Math.min(chunk,samples-offset);yield convertAudioFrame({sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'5.1',sampleFormat:format,samples:count,planes:[data.slice(offset*channels*width,(offset+count)*channels*width)],pts:{value:9007199254740993n+BigInt(offset),timeBase:{num:1n,den:8000n}}},`${format}p` as PlanarSampleFormat,{maxFrameBytes:4096});}}
      let emitted=0n;const output:Buffer[]=[];for await(const frame of reframeAudio(input(),7,pad,{maxFrameBytes:4096})){expect(frame.sampleFormat).toBe(`${format}p`);expect(frame.planes).toHaveLength(channels);expect(frame.pts?.value).toBe(9007199254740993n+emitted);emitted+=BigInt(frame.samples);output.push(Buffer.from(convertAudioFrame(frame,format,{maxFrameBytes:4096}).planes[0]!));}expect(Buffer.concat(output),`${format}/${channels}/${pad}/${chunk}`).toEqual(expected);
    }
  }
});
