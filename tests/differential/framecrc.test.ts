import { expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { openRawPcm,muxFrameCrc } from '@edge-ffmpeg/containers';
import { memoryInput } from '../helpers/wav.js';
import { collectingOutput } from '../helpers/output.js';
it('matches native bitexact PCM framecrc packet text for six codecs and bounded writes',async()=>{
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string};const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-framecrc-'));
  try{
    for(const [raw,width]of [['u8',1],['s16le',2],['s24le',3],['s32le',4],['f32le',4],['f64le',8]] as const)for(const rate of [10,8000])for(const channels of [1,2]){
      let span=1;while(span*20<=rate)span*=2;
      const bytes=Uint8Array.from({length:(span*2+1)*width*channels},(_,i)=>(i*37+13)&255);const path=join(root,'in.raw');writeFileSync(path,bytes);
      const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f',raw,'-ar',String(rate),'-ac',String(channels),'-i',path,'-c:a','copy','-bitexact','-f','framecrc','-'],{timeout:30000});
      const codec=`pcm_${raw}` as const;const input=await openRawPcm(memoryInput(bytes),{codec,sampleRate:rate,channels,maxReadBytes:span*width*channels});const sink=collectingOutput();
      await muxFrameCrc(sink.output,{codec,sampleRate:rate,channelLayout:channels===1?'mono':'stereo'},input.packets(),{bitexact:true,maxWriteBytes:13});
      expect(Buffer.from(sink.bytes()).equals(expected),`${raw}/${rate}/${channels}`).toBe(true);expect(sink.committed).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);

it('matches CLI framecrc boundaries and seek timestamps independently of the I/O budget',async()=>{
  const { FFmpeg } = await import('@edge-ffmpeg/core');
  const { createMediaBackend } = await import('@edge-ffmpeg/avformat');
  const { createNodeFileSystem } = await import('@edge-ffmpeg/runtime-node');
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-framecrc-cli-'));
  try{
    const rate=8000,data=Uint8Array.from({length:4000},(_,i)=>(i*37+13)&255),path=join(root,'in.raw');writeFileSync(path,data);
    const scenarios=[{input:[],output:[]},{input:[],output:['-ss','0.01']},{input:['-ss','0.01'],output:['-ss','0.015','-t','0.07']},{input:['-t','0.13'],output:['-ss','0.02']},{input:[],output:['-t','0']},{input:[],output:['-ss','0.99']},{input:[],output:['-t','0.000001']}];
    for(const budget of [8,258,4096]){
      const filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget});const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:budget,maxCpuTimeMs:1000,maxPendingPackets:2}});
      for(const [index,scenario]of scenarios.entries())for(const codec of ['copy','pcm_s16le','pcm_s24le','pcm_f32le']){
        const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','s16le','-ar',String(rate),'-ac','1',...scenario.input,'-i',path,...scenario.output,'-c:a',codec,'-bitexact','-f','framecrc','-'],{timeout:30000});
        const output=`/${budget}-${index}-${codec}.crc`;
        const result=await ffmpeg.exec(['-f','s16le','-ar',String(rate),'-ac','1',...scenario.input,'-i','/in.raw',...scenario.output,'-c:a',codec,'-bitexact','-f','framecrc',output]);
        expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${budget}/${index}/${codec}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);

it('matches framecrc option scope, default encoder, audio filters and channel headers',async()=>{
  const { FFmpeg } = await import('@edge-ffmpeg/core');const { createMediaBackend } = await import('@edge-ffmpeg/avformat');const { createNodeFileSystem } = await import('@edge-ffmpeg/runtime-node');
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-framecrc-scope-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256});const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for(const channels of [1,2,3,4,5,6,7,8,9])for(const [index,scope]of [{input:['-bitexact'],output:[]},{input:['-fflags','+bitexact'],output:['-fflags','+bitexact']},{input:[],output:['-bitexact','-af','volume=0.5:precision=double','-c:a','pcm_f64le']}].entries()){
      const bytes=Uint8Array.from({length:channels*2*23},(_,i)=>(i*19)&255),path=join(root,'in.raw');writeFileSync(path,bytes);
      const inputArgs=['-f','s16le','-ar','44100','-ac',String(channels),...scope.input];
      const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...inputArgs,'-i',path,...scope.output,'-f','framecrc','-'],{timeout:30000}).toString();
      const output=`/scope-${channels}-${index}.crc`,result=await ffmpeg.exec([...inputArgs,'-i','/in.raw',...scope.output,'-f','framecrc',output]);
      expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1)),'utf8'),`${channels}/${index}`).toBe(expected);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);

it('matches WAV framecrc copy and filtered encoding after input and output seeks',async()=>{
  const { FFmpeg } = await import('@edge-ffmpeg/core');const { createMediaBackend } = await import('@edge-ffmpeg/avformat');const { createNodeFileSystem } = await import('@edge-ffmpeg/runtime-node');
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-framecrc-wav-'));
  try{
    for(const rate of [8000,44100]){
      writeFileSync(join(root,'in.raw'),Uint8Array.from({length:12000},(_,i)=>(i*37)&255));
      const path=join(root,`in-${rate}.wav`);execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','s16le','-ar',String(rate),'-ac','1','-i',join(root,'in.raw'),path]);
      const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256});const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxCpuTimeMs:1000,maxPendingPackets:2}});
      for(const codec of ['copy','pcm_f32le']){
        const args=['-ss','0.01','-i',path,'-ss','0.015','-t','0.07','-c:a',codec,...(codec==='copy'?[]:['-af','volume=0.5']),'-bitexact','-f','framecrc'];
        const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...args,'-']);
        args[3]=`/in-${rate}.wav`;const output=`/${rate}-${codec}.crc`,result=await ffmpeg.exec([...args,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
