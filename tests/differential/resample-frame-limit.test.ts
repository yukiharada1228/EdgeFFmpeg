import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openWav} from '@edge-ffmpeg/containers';
const native=resolve('.build/reference/ffmpeg');
it('matches resampling frame limits and sub-sample output timing across native packet boundaries and finite filters',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-frame-limits-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    const chains=['','apad=pad_len=20:packet_size=7','aformat=dbl,apad=pad_len=20:packet_size=7','asetnsamples=7:p=1,volume=0.5:precision=double,apad=whole_len=140:packet_size=7,asetnsamples=5:p=1'];
    const profiles=[['-frames:a','0'],['-frames:a','1'],['-frames:a','2'],['-frames:a','3'],['-frames:a','-1'],['-ss','0.000125','-frames:a','2'],['-t','0.000001'],['-ss','0.001','-t','0.000001']];
    for(const [raw,width]of [['s16le',2],['f32le',4],['f64le',8]] as const)for(const samples of [21,65,1539])for(const [inputRate,outputRate]of [[8000,16000],[44100,48001]])for(const channels of [1,2]){
      const input=new Uint8Array(samples*channels*width),view=new DataView(input.buffer);for(let i=0;i<samples*channels;i++){const value=.7*Math.sin(i*.123)+.2*Math.cos(i*.49);if(width===2)view.setInt16(i*width,Math.round(value*32767),true);else if(width===4)view.setFloat32(i*width,value,true);else view.setFloat64(i*width,value,true);}writeFileSync(join(root,'input.raw'),input);
      for(const filter of chains)for(const time of profiles){
        const before=['-cpuflags','0','-f',raw,'-ar',String(inputRate),'-ac',String(channels)],after=[...(filter?['-af',filter]:[]),...time,'-ar',String(outputRate),'-f','f64le'],label=`${raw}/${samples}/${inputRate}->${outputRate}/${channels}/${filter}/${time}`;
        const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);const actual=readFileSync(join(root,out.slice(1)));expect(actual.length,label).toBe(expected.length);for(let i=0;i<actual.length/8;i++)expect(Math.abs(actual.readDoubleLE(i*8)-expected.readDoubleLE(i*8)),`${label}/${i}`).toBeLessThanOrEqual(raw==='f64le'?2e-12:1e-6);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('preserves native resampler framecrc packet text for silent streams across physical I/O budgets',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-framecrc-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256});let index=0;
    const chains=['','apad=pad_len=20:packet_size=7','aformat=dbl,apad=pad_len=20:packet_size=7','asetnsamples=7:p=1,apad=whole_len=140:packet_size=7'];
    for(const [inputRate,outputRate]of [[8000,16000],[44100,48001],[8000,100]])for(const samples of [0,21,65,1539])for(const channels of [1,2]){
      writeFileSync(join(root,'input.raw'),new Uint8Array(samples*channels*2));
      for(const filter of chains)for(const time of [[],['-frames:a','1'],['-ss','0.000125','-frames:a','2'],['-ss','0.001','-t','0.000001']]){
        const before=['-cpuflags','0','-f','s16le','-ar',String(inputRate),'-ac',String(channels)],after=[...(filter?['-af',filter]:[]),...time,'-ar',String(outputRate),'-c:a','pcm_f64le','-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']);
        for(const maxBufferBytes of [128,256]){
          const frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes,maxPendingPackets:2,maxCpuTimeMs:1000}}),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${inputRate}->${outputRate}/${samples}/${channels}/${filter}/${time}/${maxBufferBytes}`).toBe(true);
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches nonzero fixed-point resampling framecrc bytes and native packet limits for unsigned8 and signed16',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-fixed-framecrc-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[44100,48001],[48001,44100]])for(const channels of [1,2])for(const raw of ['u8','s16le']){
      const width=raw==='u8'?1:2;writeFileSync(join(root,'input.raw'),Uint8Array.from({length:1539*channels*width},(_,i)=>(i*37+13)&255));
      for(const filter of ['','asetnsamples=7:p=1','apad=pad_len=20:packet_size=7'])for(const time of [[],['-frames:a','2'],['-ss','0.000125','-frames:a','3']]){
        const before=['-cpuflags','0','-f',raw,'-ar',String(inputRate),'-ac',String(channels)],after=[...(filter?['-af',filter]:[]),...time,'-ar',String(outputRate),'-c:a',raw==='u8'?'pcm_s16le':'pcm_u8','-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${raw}/${inputRate}->${outputRate}/${channels}/${filter}/${time}\nexpected: ${expected.toString()}\nactual: ${readFileSync(join(root,out.slice(1))).toString()}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('applies native resampler frame limits to raw and WAV output after WAV AIFF AU input and scoped seeks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-framed-containers-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const [inputRate,outputRate]of [[8000,16000],[44100,48001]])for(const channels of [1,2]){
      const data=new Uint8Array(1539*channels*8),view=new DataView(data.buffer);for(let i=0;i<1539*channels;i++)view.setFloat64(i*8,.7*Math.sin(i*.123)+.2*Math.cos(i*.49),true);writeFileSync(join(root,'input.raw'),data);
      for(const [format,codec]of [['wav','pcm_f64le'],['aiff','pcm_f64be'],['au','pcm_f64be']]){
        const source=`input-${inputRate}-${channels}.${format}`;execFileSync(native,['-v','error','-f','f64le','-ar',String(inputRate),'-ac',String(channels),'-i',join(root,'input.raw'),'-c:a',codec!,'-f',format!,join(root,source)]);
        for(const filter of ['','apad=pad_len=20:packet_size=7'])for(const profile of [0,1,2])for(const target of ['f64le','wav']){
          const before=['-cpuflags','0',...(profile===1?['-ss','0.000125','-t','0.02']:[])],after=[...(filter?['-af',filter]:[]),...(profile===2?['-ss','0.001','-t','0.000001']:profile===1?['-ss','0.0005','-frames:a','2']:['-frames:a','1']),'-ar',String(outputRate),'-c:a','pcm_f64le','-bitexact','-f',target],id=index++,out=`/${id}.out`,reference=join(root,`${id}.native`),label=`${inputRate}->${outputRate}/${channels}/${format}/${filter}/${profile}/${target}`;
          execFileSync(native,['-v','error',...before,'-i',join(root,source),...after,reference]);const result=await frontend.exec([...before,'-i',`/${source}`,...after,out]);expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);
          const decode=(path:string)=>target==='f64le'?readFileSync(path):execFileSync(native,['-v','error','-f','wav','-i',path,'-f','f64le','-']),expected=decode(reference),actual=decode(join(root,out.slice(1)));expect(actual.length,label).toBe(expected.length);for(let i=0;i<actual.length/8;i++)expect(Math.abs(actual.readDoubleLE(i*8)-expected.readDoubleLE(i*8)),`${label}/${i}`).toBeLessThanOrEqual(2e-12);
          if(target==='wav'){const audio=await openWav(await filesystem.openRead(out),{maxReadBytes:256});expect(audio.info,label).toMatchObject({channels,sampleRate:outputRate,durationSamples:BigInt(actual.length/(channels*8))});}
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
