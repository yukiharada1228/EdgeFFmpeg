import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openWav,openAiff} from '@edge-ffmpeg/containers';
import {referenceRemixArithmetic} from '../helpers/remix-profile.js';
const native=resolve('.build/reference/ffmpeg');
function fixture(raw:string,width:number,channels:number){
  const data=Uint8Array.from({length:66*channels*width},(_,i)=>(i*37+13)&255),view=new DataView(data.buffer);
  if(raw.startsWith('f'))for(let i=0;i<66*channels;i++){const value=(i%37-18)/16;if(width===4)view.setFloat32(i*4,value,raw.endsWith('le'));else view.setFloat64(i*8,value,raw.endsWith('le'));}
  return data;
}
it('matches CLI mono stereo remixing with linear companded and endian raw codecs',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-remix-cli-'));
  try{
    const arithmetic=referenceRemixArithmetic();console.info(`Native rematrix arithmetic profile: ${arithmetic}`);
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend({remixArithmetic:arithmetic}),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const formats=[['u8',1],['s16be',2],['u24be',3],['s32le',4],['f32le',4],['f64be',8],['alaw',1],['mulaw',1]] as const;
    for(const [raw,width]of formats)for(const channels of [1,2]){
      const path=join(root,'input.raw');writeFileSync(path,fixture(raw,width,channels));
      for(const [target]of formats){
        const input=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],tail=['-ac',String(channels===1?2:1),'-f',target],expected=execFileSync(native,['-v','error',...input,'-i',path,...tail,'-']);
        const output=`/${raw}-${target}-${channels}.raw`,result=await ffmpeg.exec([...input,'-i','/input.raw',...tail,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${raw}->${target}/${channels}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('places remixing at native filter format negotiation boundaries with timing and FIFO limits',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-remix-filters-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend({remixArithmetic:referenceRemixArithmetic()}),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const filters=['anull','volume=0.5','volume=0.5:precision=fixed','volume=0.5:precision=double','asetnsamples=7:p=1,volume=0.5','volume=0.5:precision=fixed,volume=0.5','volume=0.5,asetnsamples=7:p=1,volume=0.5:precision=fixed,asetrate=11025'];
    for(const [raw,width]of [['s16le',2],['f32le',4],['f64le',8]] as const)for(const target of ['s16be','f32be','f64le'])for(const channels of [1,2]){
      const path=join(root,'input.raw');writeFileSync(path,fixture(raw,width,channels));
      for(const [index,filter]of filters.entries()){
        const input=['-cpuflags','0','-ss','0.000125','-f',raw,'-ar','8000','-ac',String(channels)],tail=['-af',filter,'-ac',String(channels===1?2:1),'-ss','0.0005','-t','0.01','-frames:a','3','-c:a',`pcm_${target}`,'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...input,'-i',path,...tail,'-']),output=`/${raw}-${target}-${channels}-${index}.crc`,result=await ffmpeg.exec([...input,'-i','/input.raw',...tail,output]);
        expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${raw}->${target}/${channels}/${filter}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('writes destination channel metadata and counts in WAV and AIFF after remixing',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-remix-containers-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend({remixArithmetic:referenceRemixArithmetic()}),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    for(const channels of [1,2])for(const container of ['wav','aiff']){
      const path=join(root,'input.raw');writeFileSync(path,fixture('s16le',2,channels));const input=['-f','s16le','-ar','8000','-ac',String(channels)],outChannels=channels===1?2:1,output=`/${channels}.${container}`;
      const result=await ffmpeg.exec([...input,'-i','/input.raw','-ac',String(outChannels),output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      const parsed=container==='wav'?await openWav(await filesystem.openRead(output),{maxReadBytes:128}):await openAiff(await filesystem.openRead(output),{maxReadBytes:128});expect(parsed.info.channels).toBe(outChannels);expect(parsed.info.durationSamples).toBe(66n);
      const expected=execFileSync(native,['-v','error',...input,'-i',path,'-ac',String(outChannels),'-f','s16le','-']),actual=execFileSync(native,['-v','error','-i',join(root,output.slice(1)),'-f','s16le','-']);expect(actual).toEqual(expected);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
