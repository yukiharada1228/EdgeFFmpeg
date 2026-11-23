import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {padAudio} from '@edge-ffmpeg/avfilter';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat,PackedSampleFormat} from '@edge-ffmpeg/swresample';
import {encodePcm} from '@edge-ffmpeg/avcodec';
import {frameCrcChecksum} from '@edge-ffmpeg/containers';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
it('matches native finite apad silence packets timestamps and checksums for packed and planar audio',async()=>{
  const formats:[PackedSampleFormat,string,number][]=[['u8','u8',1],['s16','s16le',2],['s32','s32le',4],['flt','f32le',4],['dbl','f64le',8]];
  for(const [format,raw,width]of formats)for(const channels of [1,2,6])for(const planar of [false,true])for(const padding of [0,1,10]){
    const samples=13,data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++){if(width===1)view.setUint8(i,(i*37)&255);else if(format==='s16')view.setInt16(i*2,(i*3137)%65536-32768,true);else if(format==='s32')view.setInt32(i*4,Math.imul(i+1,2654435761),true);else if(width===4)view.setFloat32(i*4,(i%17-8)/16,true);else view.setFloat64(i*8,(i%17-8)/16,true);}
    const sampleFormat=`${format}${planar?'p':''}` as AudioSampleFormat,expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels),'-i','pipe:0','-af',`aformat=sample_fmts=${sampleFormat},asetnsamples=5:p=0,apad=pad_len=${padding}:packet_size=7`,'-bitexact','-f','framecrc','-'],{input:data,encoding:'utf8'}).split('\n').filter(line=>line.startsWith('0,')).map(line=>{const fields=line.split(',').map(value=>value.trim());return {pts:BigInt(fields[2]!),samples:BigInt(fields[3]!),bytes:Number(fields[4]),crc:Number(fields[5])};});
    async function* input():AsyncIterable<AudioFrameData>{for(let offset=0;offset<samples;offset+=5){const count=Math.min(5,samples-offset);yield convertAudioFrame({sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'5.1',sampleFormat:format,samples:count,planes:[data.slice(offset*channels*width,(offset+count)*channels*width)],pts:{value:BigInt(offset),timeBase:{num:1n,den:8000n}}},sampleFormat,{maxFrameBytes:4096});}}
    const actual=[];for await(const frame of padAudio(input(),{padSamples:BigInt(padding),packetSamples:7,maxFrameBytes:4096})){const packet=encodePcm(frame,'pcm_s16le',{maxFrameBytes:4096});actual.push({pts:packet.pts,samples:packet.duration,bytes:packet.data.length,crc:frameCrcChecksum(packet.data)});}expect(actual,`${sampleFormat}/${channels}/${padding}`).toEqual(expected);
  }
});
