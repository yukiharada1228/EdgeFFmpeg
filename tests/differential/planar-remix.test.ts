import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {remixAudioFrame,convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {PackedSampleFormat,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {referenceRemixArithmetic} from '../helpers/remix-profile.js';
const formats:[PackedSampleFormat,string,number][]=[['u8','u8',1],['s16','s16le',2],['s32','s32le',4],['flt','f32le',4],['dbl','f64le',8]];
it('matches planar mono stereo remixing across precision and packing combinations against native',()=>{
  const arithmetic=referenceRemixArithmetic();
  for(const [source,raw,width]of formats)for(const [target,outputRaw]of formats)for(const channels of [1,2] as const){
    const count=64*channels,data=new Uint8Array(count*width),view=new DataView(data.buffer);
    for(let i=0;i<count;i++){const value=(i%37-18)/16;if(source==='u8')view.setUint8(i,(i*37)&255);else if(source==='s16')view.setInt16(i*2,(i*3137)%65536-32768,true);else if(source==='s32')view.setInt32(i*4,(Math.imul(i+1,2654435761))|0,true);else if(source==='flt')view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}
    const outChannels=channels===1?2:1,frame={sampleRate:8000,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:source,samples:64,planes:[data],pts:null};
    const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels),'-i','pipe:0','-af',`aformat=sample_fmts=${source}p`,'-ac',String(outChannels),'-f',outputRaw,'-'],{input:data,timeout:30000});
    for(const sourcePlanar of [false,true])for(const targetPlanar of [false,true]){
      const input=sourcePlanar?convertAudioFrame(frame,`${source}p` as AudioSampleFormat,{maxFrameBytes:4096}):frame,targetFormat=`${target}${targetPlanar?'p':''}` as AudioSampleFormat;
      const output=remixAudioFrame(input,outChannels,targetFormat,{maxFrameBytes:4096,arithmetic});expect(output.sampleFormat).toBe(targetFormat);expect(output.planes).toHaveLength(targetPlanar?outChannels:1);
      const packed=convertAudioFrame(output,target,{maxFrameBytes:4096});expect(Buffer.from(packed.planes[0]!),`${source}->${target}/${channels}/${sourcePlanar}/${targetPlanar}`).toEqual(expected);
    }

  }
},30000);
