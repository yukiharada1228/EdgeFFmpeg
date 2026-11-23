import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {openWav,openAiff,openAu} from '@edge-ffmpeg/containers';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
it('matches native output seek and duration across finite padding packet sections and planar FIFO',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-apad-trim-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    const profiles=[[],['-ss','0.000125'],['-ss','0.00175'],['-ss','0.002625'],['-ss','1'],['-t','0'],['-ss','0.001','-t','0.0005'],['-ss','0.00175','-to','0.003']];
    const chains=['apad=pad_len=20:packet_size=7','asetnsamples=5:p=0,apad=pad_len=20:packet_size=7','aformat=dblp,apad=pad_len=20:packet_size=7,asetnsamples=5:p=1','apad=pad_len=5:packet_size=3,apad=pad_len=15:packet_size=7'];
    for(const [raw,width]of [['s16le',2],['f64le',8]] as const)for(const channels of [1,2])for(const filter of chains)for(const time of profiles){
      const data=new Uint8Array(13*channels*width),view=new DataView(data.buffer);for(let i=0;i<13*channels;i++){if(width===2)view.setInt16(i*2,(i*3137)%65536-32768,true);else view.setFloat64(i*8,(i%17-8)/16,true);}writeFileSync(join(root,'input.raw'),data);
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',filter,...time,'-bitexact','-f','framecrc'],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${raw}/${channels}/${filter}/${time.join(' ')}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);

it('writes exact trimmed padding sample counts and interoperable PCM in WAV AIFF and AU',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-apad-trim-containers-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const [raw,width]of [['s16le',2],['f64le',8]] as const)for(const channels of [1,2])for(const container of ['wav','aiff','au'])for(const time of [['-ss','0.00175','-t','0.00075'],['-ss','0.001','-t','0.002'],['-t','0']]){
      const data=new Uint8Array(13*channels*width),view=new DataView(data.buffer);for(let i=0;i<13*channels;i++){if(width===2)view.setInt16(i*2,(i*3137)%65536-32768,true);else view.setFloat64(i*8,(i%17-8)/16,true);}writeFileSync(join(root,'input.raw'),data);
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af','aformat=dblp,apad=pad_len=20:packet_size=7',...time,'-bitexact','-f',container],out=`/${index++}.${container}`,reference=join(root,`reference-${index}.${container}`);execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,reference]);
      const result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);const decode=(path:string)=>execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f',container,'-i',path,'-f','s16le','-']),expected=decode(reference),actual=decode(join(root,out.slice(1)));expect(actual).toEqual(expected);
      const handle=await filesystem.openRead(out),options={maxReadBytes:256},audio=container==='wav'?await openWav(handle,options):container==='aiff'?await openAiff(handle,options):await openAu(handle,options);expect(audio.info).toMatchObject({sampleRate:8000,channels,durationSamples:BigInt(expected.length/(2*channels))});
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
