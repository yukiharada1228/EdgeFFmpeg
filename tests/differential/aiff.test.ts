import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openAiff} from '@edge-ffmpeg/containers';
const native=resolve('.build/reference/ffmpeg');
const codecs=['pcm_s8','pcm_s16be','pcm_s24be','pcm_s32be','pcm_s16le','pcm_f32be','pcm_f64be','pcm_alaw','pcm_mulaw'] as const;
function data(samples:number,channels:number){const bytes=new Uint8Array(samples*channels*2),view=new DataView(bytes.buffer);for(let i=0;i<samples*channels;i++)view.setInt16(i*2,(i*313)%65536-32768,true);return bytes;}
it('matches native bitexact AIFF AIFC files and auto-detected decode for nine codecs',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-aiff-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    for(const rate of [10,8000,44100])for(const channels of [1,2]){
      const input=join(root,'input.raw');writeFileSync(input,data(37,channels));
      for(const codec of codecs){
        const prefix=`${rate}-${channels}-${codec}`,path=join(root,`${prefix}.native`),args=['-f','s16le','-ar',String(rate),'-ac',String(channels)];
        execFileSync(native,['-v','error',...args,'-i',input,'-c:a',codec,'-bitexact','-f','aiff',path]);
        const output=`/${prefix}.aiff`,result=await ffmpeg.exec([...args,'-i','/input.raw','-c:a',codec,'-bitexact',output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(readFileSync(path));
        const opened=await openAiff(await filesystem.openRead(output),{maxReadBytes:128});expect(opened.info).toMatchObject({codec,channels,sampleRate:rate,durationSamples:37n});
        const expected=execFileSync(native,['-v','error','-cpuflags','0','-i',path,'-f','s16le','-']),decoded=`/${prefix}.raw`;
        const decode=await ffmpeg.exec(['-cpuflags','0','-i',`/${prefix}.native`,'-f','s16le',decoded]);expect(decode.exitCode,JSON.stringify(decode.diagnostics)).toBe(0);expect(readFileSync(join(root,decoded.slice(1)))).toEqual(expected);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches AIFF packet framing seek duration limits and stateful filter timing',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-aiff-time-'));
  try{
    writeFileSync(join(root,'input.raw'),data(12001,2));
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    for(const codec of codecs){
      const path=join(root,`${codec}.bin`);execFileSync(native,['-v','error','-f','s16le','-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a',codec,'-bitexact','-f','aiff',path]);
      const scenarios=[{input:['-ss','0.001'],output:['-ss','0.01','-t','0.1','-frames:a','2']},{input:['-t','0.13'],output:['-t','0.1']},{input:[],output:['-ss','0.01','-t','0.000001']},{input:[],output:['-frames:a','0']},{input:['-ss','1.500125'],output:[]},{input:['-ss','1.6'],output:[]}];
      for(const [index,scenario]of scenarios.entries())for(const copy of [true,false]){
        const tail=[...scenario.output,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1,asetrate=11025','-c:a','pcm_s16be']),'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error','-cpuflags','0',...scenario.input,'-i',path,...tail,'-']),output=`/${codec}-${index}-${copy}.crc`,result=await ffmpeg.exec(['-cpuflags','0',...scenario.input,'-i',`/${codec}.bin`,...tail,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${codec}/${index}/${copy}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('reads native named layouts and writes interoperable AIFF channel bitmaps and default codecs',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-aiff-layout-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
    for(const [channels,mask]of [[3,0xb],[4,0x107],[5,0x607],[6,0x60f]] as const){
      const input=join(root,'input.raw');writeFileSync(input,data(31,channels));const nativePath=join(root,`${channels}.native.aiff`);execFileSync(native,['-v','error','-f','s16le','-ar','8000','-ac',String(channels),'-i',input,'-bitexact',nativePath]);
      const opened=await openAiff(await filesystem.openRead(`/${channels}.native.aiff`),{maxReadBytes:256});expect(opened.info.channelMask).toBe(mask);
      const output=`/${channels}.aifc`,result=await ffmpeg.exec(['-i',`/${channels}.native.aiff`,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);const own=await openAiff(await filesystem.openRead(output),{maxReadBytes:256});expect(own.info.codec).toBe('pcm_s16be');expect(own.info.channelMask).toBe(mask);
      const expected=execFileSync(native,['-v','error','-i',nativePath,'-f','s16le','-']),actual=execFileSync(native,['-v','error','-i',join(root,output.slice(1)),'-f','s16le','-']);expect(actual).toEqual(expected);
      const probe=(file:string)=>execFileSync(resolve('.build/reference/ffprobe'),['-v','error','-show_entries','stream=channel_layout','-of','default=nw=1:nk=1',file],{encoding:'utf8'}).trim();expect(probe(join(root,output.slice(1)))).toBe(probe(nativePath));
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
