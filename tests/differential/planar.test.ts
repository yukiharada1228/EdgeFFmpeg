import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {PackedSampleFormat,PlanarSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const formats:[PackedSampleFormat,string,number][]=[['u8','u8',1],['s16','s16le',2],['s32','s32le',4],['flt','f32le',4],['dbl','f64le',8]];
it('matches scalar native packed planar conversion through every precision pair and channel count',()=>{
  for(const channels of [1,2,6])for(const [source,raw,width]of formats){
    const samples=33,data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++){if(source==='u8')view.setUint8(i,(i*37+13)&255);else if(source==='s16')view.setInt16(i*2,(i*3137)%65536-32768,true);else if(source==='s32')view.setInt32(i*4,Math.imul(i+1,2654435761),true);else if(source==='flt')view.setFloat32(i*4,(i%37-18)/16,true);else view.setFloat64(i*8,(i%37-18)/16,true);}
    const frame:AudioFrameData={sampleRate:8000,channels,channelLayout:channels===1?'mono':channels===2?'stereo':'5.1',sampleFormat:source,samples,planes:[data],pts:null};
    const sourcePlanar=convertAudioFrame(frame,`${source}p` as PlanarSampleFormat,{maxFrameBytes:65536});
    for(const [target,targetRaw,targetWidth]of formats){
      const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels),'-i','pipe:0','-af',`aformat=sample_fmts=${source}p,aformat=sample_fmts=${target}p`,'-f',targetRaw,'-'],{input:data});
      for(const input of [frame,sourcePlanar])for(const planar of [false,true]){
        const output=convertAudioFrame(input,`${target}${planar?'p':''}` as PackedSampleFormat|PlanarSampleFormat,{maxFrameBytes:65536});
        const packed=planar?convertAudioFrame(output,target,{maxFrameBytes:65536}):output;expect(Buffer.from(packed.planes[0]!),`${source}->${target}/${channels}/${input.sampleFormat}/${planar}`).toEqual(expected);
        if(planar)for(let channel=0;channel<channels;channel++){const plane=output.planes[channel]!;for(let sample=0;sample<samples;sample++)expect(plane.subarray(sample*targetWidth,(sample+1)*targetWidth)).toEqual(new Uint8Array(expected.subarray((sample*channels+channel)*targetWidth,(sample*channels+channel+1)*targetWidth)));}
      }
    }
  }
},60000);
