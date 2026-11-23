import { expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createMediaBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
import { openWav } from '@edge-ffmpeg/containers';
const native=resolve('.build/reference/ffmpeg');
it('matches asetrate framecrc timing with scoped seeks durations packet limits and mixed filters',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-asetrate-'));
  try{
    const frontends=await Promise.all([16,1024].map(async budget=>new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget}),backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:budget,maxCpuTimeMs:1000,maxPendingPackets:2}})));
    for(const rate of [8000,44100]){
      const input=join(root,`${rate}.raw`);writeFileSync(input,Uint8Array.from({length:20000},(_,i)=>(i*37+13)&255));
      for(const target of [11025,20000])for(const [filterIndex,filter]of [`asetrate=${target}`,`volume=0.5:precision=fixed,asetrate=r=${target}`,`asetrate=sample_rate=22050,anull,asetrate=${target},volume=0.5:precision=double`].entries()){
        const scenarios=[{input:[],output:[]},{input:['-ss','0.01'],output:['-ss','0.015','-t','0.07']},{input:['-t','0.13'],output:['-ss','0.02']},{input:[],output:['-ss','0.015','-frames:a','2']},{input:[],output:['-t','0.000001']},{input:[],output:['-to','0.1','-ss','0.015']}];
        for(const [index,scenario]of scenarios.entries()){
          const declarations=['-f','s16le','-ar',String(rate),'-ac','1'],outputArgs=[...scenario.output,'-af',filter,'-ar',String(target),'-c:a',filterIndex===2?'pcm_f64le':'pcm_s16le','-bitexact','-f','framecrc'];
          const expected=execFileSync(native,['-v','error',...declarations,...scenario.input,'-i',input,...outputArgs,'-'],{timeout:30000});
          for(const [budget,ffmpeg]of frontends.entries()){
            const output=`/${rate}-${target}-${filterIndex}-${index}-${budget}.crc`,result=await ffmpeg.exec([...declarations,...scenario.input,'-i',`/${rate}.raw`,...outputArgs,output]);
            expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${rate}/${target}/${filterIndex}/${index}/${budget}`).toBe(true);
          }
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches asetrate WAV rate duration and unchanged PCM samples without resampling',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-asetrate-wav-'));
  try{
    const data=Uint8Array.from({length:10000},(_,i)=>(i*37)&255);writeFileSync(join(root,'input.raw'),data);
    execFileSync(native,['-v','error','-f','s16le','-ar','44100','-ac','2','-i',join(root,'input.raw'),join(root,'input.wav')]);
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for(const [index,filter]of ['asetrate=20000','asetrate','asetrate=20000,asetrate=11025'].entries()){
      const actual=`/actual-${index}.wav`,result=await ffmpeg.exec(['-i','/input.wav','-af',filter,actual]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      const path=join(root,`native-${index}.wav`);execFileSync(native,['-v','error','-i',join(root,'input.wav'),'-af',filter,path]);
      const output=await openWav(await filesystem.openRead(actual),{maxReadBytes:256}),reference=await openWav(await filesystem.openRead(`/native-${index}.wav`),{maxReadBytes:256});
      expect(output.info.sampleRate).toBe(reference.info.sampleRate);expect(output.info.durationSamples).toBe(2500n);const chunks=[];for await(const packet of output.packets())chunks.push(packet.data);expect(Buffer.concat(chunks)).toEqual(Buffer.from(data));
    }
    const rejected=await ffmpeg.exec(['-i','/input.wav','-af','asetrate=20000','-ar','44100','/unsupported.wav']);expect(rejected.diagnostics[0]?.code).toBe('unsupported-command');
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
