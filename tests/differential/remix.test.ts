import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {remixAudioFrame} from '@edge-ffmpeg/swresample';
import type {PackedSampleFormat} from '@edge-ffmpeg/swresample';
import {referenceRemixArithmetic} from '../helpers/remix-profile.js';
const formats:[PackedSampleFormat,string,number][]=[['u8','u8',1],['s16','s16le',2],['s32','s32le',4],['flt','f32le',4],['dbl','f64le',8]];
it('matches canonical mono stereo rematrixing across packed sample formats against scalar native FFmpeg',()=>{
  const arithmetic=referenceRemixArithmetic();
  for(const [source,raw,width]of formats)for(const [target,outputRaw]of formats)for(const channels of [1,2] as const){
    const count=64*channels,data=new Uint8Array(count*width),view=new DataView(data.buffer);
    for(let i=0;i<count;i++){const value=(i%37-18)/16;if(source==='u8')view.setUint8(i,(i*37)&255);else if(source==='s16')view.setInt16(i*2,(i*3137)%65536-32768,true);else if(source==='s32')view.setInt32(i*4,(Math.imul(i+1,2654435761))|0,true);else if(source==='flt')view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}
    const outChannels=channels===1?2:1,actual=remixAudioFrame({sampleRate:8000,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:source,samples:64,planes:[data],pts:null},outChannels,target,{maxFrameBytes:4096,arithmetic});
    const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels),'-i','pipe:0','-ac',String(outChannels),'-f',outputRaw,'-'],{input:data,timeout:30000});
    expect(Buffer.from(actual.planes[0]!).equals(expected),`${source}->${target} ${channels}->${outChannels}`).toBe(true);
  }
},30000);
it('matches fixed16 remix rounding over the complete mono domain and stereo boundary pairs',()=>{
  for(const channels of [1,2] as const){
    const samples=65536,data=new Uint8Array(samples*channels*2),view=new DataView(data.buffer);
    for(let i=0;i<samples;i++){view.setInt16(i*channels*2,i-32768,true);if(channels===2)view.setInt16((i*2+1)*2,(Math.imul(i+1,31337))%65536-32768,true);}
    const actual=remixAudioFrame({sampleRate:8000,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:'s16',samples,planes:[data],pts:null},channels===1?2:1,'s16',{maxFrameBytes:524288});
    for(const flags of [[],['-cpuflags','0']]){const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...flags,'-f','s16le','-ar','8000','-ac',String(channels),'-i','pipe:0','-ac',String(channels===1?2:1),'-f','s16le','-'],{input:data});expect(Buffer.from(actual.planes[0]!)).toEqual(expected);}
  }
},30000);
