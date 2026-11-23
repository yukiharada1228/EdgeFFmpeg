import { expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createMediaBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
import { openWav } from '@edge-ffmpeg/containers';
it('matches declared raw PCM input, raw output and default codec selection against native FFmpeg',async()=>{
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string};const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-raw-'));const codecs=['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'] as const;
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:1024,maxWriteBytes:1024});const frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:1024,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for(const source of codecs){
      const width=source==='pcm_u8'?1:source==='pcm_s16le'?2:source==='pcm_s24le'?3:source==='pcm_f64le'?8:4;
      const data=Uint8Array.from({length:width*64},(_,i)=>(i*37+13)&255),view=new DataView(data.buffer);
      if(source==='pcm_f32le'||source==='pcm_f64le')for(let i=0;i<64;i++){if(width===4)view.setFloat32(i*4,(i-32)/32,true);else view.setFloat64(i*8,(i-32)/32,true);}
      const raw=source==='pcm_u8'?'u8':source.slice(4),input=join(root,`${source}.raw`);writeFileSync(input,data);
      for(const target of codecs){
        const outputFormat=target==='pcm_u8'?'u8':target.slice(4);
        const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac','2','-i',input,'-f',outputFormat,'-'],{timeout:30000});
        const output=`/${source}-${target}.raw`;const result=await frontend.exec(['-cpuflags','0','-f',raw,'-ar','8000','-ac','2','-i',`/${source}.raw`,'-f',outputFormat,output]);
        expect(result.exitCode,JSON.stringify({source,target,diagnostics:result.diagnostics})).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${source}->${target}`).toBe(true);
      }
      const expectedWav=join(root,`${source}.native.wav`);execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac','2','-i',input,expectedWav],{timeout:30000});
      const result=await frontend.exec(['-cpuflags','0','-f',raw,'-ar','8000','-ac','2','-i',`/${source}.raw`,`/${source}.wav`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      const actual=await openWav(await filesystem.openRead(`/${source}.wav`),{maxReadBytes:1024});expect(actual.info.codec).toBe('pcm_s16le');expect(actual.info.sampleRate).toBe(8000);expect(actual.info.channels).toBe(2);
      const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-i',expectedWav,'-c:a','copy','-f','s16le','-'],{timeout:30000});const chunks=[];for await(const packet of actual.packets())chunks.push(packet.data);expect(Buffer.concat(chunks)).toEqual(expected);
      const copied=await frontend.exec(['-f',raw,'-ar','8000','-ac','2','-i',`/${source}.raw`,'-c','copy','-f',raw,`/${source}.copy.raw`]);expect(copied.exitCode).toBe(0);expect(new Uint8Array(readFileSync(join(root,`${source}.copy.raw`)))).toEqual(data);
      const wavRaw=await frontend.exec(['-i',`/${source}.wav`,'-f','s16le',`/${source}.wav-to-raw`]);expect(wavRaw.exitCode).toBe(0);expect(readFileSync(join(root,`${source}.wav-to-raw`))).toEqual(expected);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('matches raw PCM defaults, channel metadata and scoped timing against native FFmpeg',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-raw-defaults-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});const frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:4096,maxCpuTimeMs:1000,maxPendingPackets:2}});
    writeFileSync(join(root,'default.raw'),new Uint8Array([0,128,0,0,255,127]));
    const basic=await frontend.exec(['-f','s16le','-i','/default.raw','/default.wav']);expect(basic.exitCode).toBe(0);
    const defaults=await openWav(await filesystem.openRead('/default.wav'),{maxReadBytes:4096});expect(defaults.info).toMatchObject({codec:'pcm_s16le',channels:1,sampleRate:44100,durationSamples:3n});
    for(const channels of [1,2,3,4,5,6,7,8,9,16]){
      const data=new Uint8Array(channels*2*16),input=join(root,`${channels}.raw`);writeFileSync(input,data);
      const native=join(root,`${channels}.native.wav`);execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','s16le','-ar','8000','-ac',String(channels),'-i',input,'-c:a','pcm_f32le',native],{timeout:30000});
      const result=await frontend.exec(['-f','s16le','-ar','8000','-ac',String(channels),'-i',`/${channels}.raw`,'-ar','8000','-ac',String(channels),'-c:a','pcm_f32le',`/${channels}.wav`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      const actual=await openWav(await filesystem.openRead(`/${channels}.wav`),{maxReadBytes:4096}),expected=await openWav(await filesystem.openRead(`/${channels}.native.wav`),{maxReadBytes:4096});
      expect(actual.info.channels).toBe(expected.info.channels);expect(actual.info.channelMask??0).toBe(expected.info.channelMask??0);expect(actual.info.durationSamples).toBe(expected.info.durationSamples);
    }
    for(const rate of [10,8000]){
      const data=new Uint8Array(rate*4),view=new DataView(data.buffer);for(let i=0;i<rate*2;i++)view.setInt16(i*2,(i*257)%65536-32768,true);
      const input=join(root,`time-${rate}.raw`);writeFileSync(input,data);
      const scenarios=[{input:['-ss','0.15'],output:[]},{input:[],output:['-ss','0.15','-t','0.35']},{input:['-ss','0.15','-t','0.31'],output:[]},{input:[],output:['-t','0.000001']},{input:['-t','0'],output:[]},{input:['-t','0.000001'],output:['-ss','0.15']}];
      for(const [index,scenario]of scenarios.entries())for(const codec of ['copy','pcm_s16le']){
        const args=['-f','s16le','-ar',String(rate),'-ac','2'];
        const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...args,...scenario.input,'-i',input,...scenario.output,'-c:a',codec,'-f','s16le','-'],{timeout:30000});
        const output=`/time-${rate}-${index}-${codec}.raw`;const result=await frontend.exec([...args,...scenario.input,'-i',`/time-${rate}.raw`,...scenario.output,'-c:a',codec,'-f','s16le',output]);
        expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),JSON.stringify({rate,scenario,codec})).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('matches raw PCM layout-guessing thresholds against native framecrc headers',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-layout-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256});const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for(const channels of [1,2,3])for(const threshold of [0,1,2,3])for(const codec of ['copy','pcm_s16le']){
      const path=join(root,'input.raw');writeFileSync(path,new Uint8Array(channels*2*3));
      const args=['-guess_layout_max',String(threshold),'-f','s16le','-ar','8000','-ac',String(channels)];
      const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...args,'-i',path,'-c:a',codec,'-bitexact','-f','framecrc','-']);
      const output=`/${channels}-${threshold}-${codec}.crc`,result=await ffmpeg.exec([...args,'-i','/input.raw','-c:a',codec,'-bitexact','-f','framecrc',output]);
      expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
