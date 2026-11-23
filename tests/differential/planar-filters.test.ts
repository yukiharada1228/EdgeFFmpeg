import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {compileAudioFilterChain} from '@edge-ffmpeg/avfilter';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {PackedSampleFormat,PlanarSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
it('processes planar volume format rate and FIFO chains with exact native scalar samples',async()=>{
  const formats:[PackedSampleFormat,string,number][]=[['u8','u8',1],['s16','s16le',2],['s32','s32le',4],['flt','f32le',4],['dbl','f64le',8]];
  const chains=['anull','asetrate=11025','volume=0.5:precision=fixed','volume=0.5:precision=float','asetnsamples=7:p=1,volume=0.5:precision=double,asetnsamples=5:p=1','anull,asetrate=11025,asetnsamples=7:p=0,aformat=dbl,volume=0.5:precision=fixed'];
  for(const [format,raw,width]of formats)for(const channels of [1,2,6])for(const description of chains){
    const samples=33,data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++){if(width===1)view.setUint8(i,(i*37+13)&255);else if(format==='s16')view.setInt16(i*2,(i*3137)%65536-32768,true);else if(format==='s32')view.setInt32(i*4,Math.imul(i+1,2654435761),true);else if(width===4)view.setFloat32(i*4,(i%37-18)/16,true);else view.setFloat64(i*8,(i%37-18)/16,true);}
    const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels),'-i','pipe:0','-af',`aformat=sample_fmts=${format}p,${description}`,'-f','s16le','-'],{input:data});
    async function* frames():AsyncIterable<AudioFrameData>{for(let offset=0;offset<samples;offset+=5){const count=Math.min(5,samples-offset);yield convertAudioFrame({sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'5.1',sampleFormat:format,samples:count,planes:[data.slice(offset*channels*width,(offset+count)*channels*width)],pts:{value:BigInt(offset),timeBase:{num:1n,den:8000n}}},`${format}p` as PlanarSampleFormat,{maxFrameBytes:4096});}}
    const chain=compileAudioFilterChain(description,{outputSampleFormat:'s16'}),output:Buffer[]=[];let count=0n;for await(const frame of chain.process(frames(),{maxFrameBytes:4096})){expect(frame.pts?.value).toBe(count);expect(frame.sampleRate).toBe(chain.outputSampleRate(8000));count+=BigInt(frame.samples);output.push(Buffer.from(convertAudioFrame(frame,'s16',{maxFrameBytes:4096}).planes[0]!));}expect(Buffer.concat(output),`${format}/${channels}/${description}`).toEqual(expected);expect(count).toBe(chain.outputSamples(BigInt(samples)));
  }
});
