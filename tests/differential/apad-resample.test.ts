import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openWav,openAiff,openAu} from '@edge-ffmpeg/containers';
const native=resolve('.build/reference/ffmpeg');
it('matches finite padding before and after negotiated resampling with exact counts and scalar PCM tolerances',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-apad-resample-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    const chains=['apad=pad_len=20:packet_size=7','apad=whole_len=70:packet_size=7','apad=pad_dur=0.001:packet_size=7','apad=whole_dur=0.005:packet_size=7','apad=pad_len=20:packet_size=7,aformat=dbl','aformat=dbl,apad=pad_len=20:packet_size=7','apad=pad_dur=0.001:packet_size=7,volume=0.5:precision=double,apad=whole_len=140:packet_size=7','asetnsamples=5:p=1,apad=pad_len=20:packet_size=7,asetnsamples=7:p=1','apad=pad_dur=0.001:packet_size=7,asetrate=11025,apad=pad_dur=0.001:packet_size=7','aformat=dblp,apad=pad_len=20:packet_size=7,aformat=flt,apad=whole_dur=0.005:packet_size=7'];
    for(const [raw,width]of [['s16le',2],['f32le',4],['f64le',8]] as const)for(const samples of [0,1,21,65,257])for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[44100,48001]])for(const channels of [1,2]){
      const data=new Uint8Array(samples*channels*width),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++){const value=Math.sin(i*.123)*.7+.2*Math.cos(i*.49);if(width===2)view.setInt16(i*width,Math.round(value*32767),true);else if(width===4)view.setFloat32(i*width,value,true);else view.setFloat64(i*width,value,true);}writeFileSync(join(root,'input.raw'),data);
      for(const filter of chains)for(const target of ['f64le','s16le']){
        const before=['-cpuflags','0','-f',raw,'-ar',String(inputRate),'-ac',String(channels)],after=['-af',filter,'-ar',String(outputRate),'-f',target],label=`${raw}/${samples}/${inputRate}->${outputRate}/${channels}/${filter}/${target}`;
        const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);const actual=readFileSync(join(root,out.slice(1))),step=target==='s16le'?2:8;expect(actual.length,label).toBe(expected.length);
        const tolerance=step===2?1/32768+1e-6:raw==='f64le'&&!filter.includes('aformat=flt')?2e-12:1e-6;
        for(let i=0;i<actual.length/step;i++){const a=step===2?actual.readInt16LE(i*step)/32768:actual.readDoubleLE(i*step),b=step===2?expected.readInt16LE(i*step)/32768:expected.readDoubleLE(i*step);expect(Math.abs(a-b),`${label}/${i}`).toBeLessThanOrEqual(tolerance);}
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('writes interoperable finite padding and resampling containers with scoped time selection and exact metadata',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-apad-resample-containers-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    const chains=['apad=whole_len=70:packet_size=7','apad=pad_dur=1ms:packet_size=7,aformat=flt,apad=whole_len=70:packet_size=7,aformat=dbl','aformat=dblp,apad=whole_dur=0.01:packet_size=7','apad=pad_len=70:packet_size=7,asetrate=11025,apad=whole_dur=0.01:packet_size=7'];
    for(const samples of [1,65])for(const [inputRate,outputRate]of [[8000,16000],[16000,8000]])for(const channels of [1,2]){
      const data=new Uint8Array(samples*channels*8),view=new DataView(data.buffer);for(let i=0;i<samples*channels;i++)view.setFloat64(i*8,Math.sin(i*.123)*.7+.2*Math.cos(i*.49),true);writeFileSync(join(root,'input.raw'),data);
      for(const filter of chains)for(const [format,codec]of [['wav','pcm_f64le'],['aiff','pcm_f64be'],['au','pcm_f64be']])for(const time of [[],['-ss','0.0005','-t','0.002'],['-ss','0.001','-to','0.003']]){
        const before=['-cpuflags','0','-f','f64le','-ar',String(inputRate),'-ac',String(channels)],after=['-af',filter,...time,'-ar',String(outputRate),'-c:a',codec!,'-bitexact','-f',format!],id=index++,out=`/${id}.out`,reference=join(root,`${id}.native`),label=`${samples}/${inputRate}->${outputRate}/${channels}/${filter}/${format}/${time}`;
        execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,reference]);const result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);
        const decode=(path:string)=>execFileSync(native,['-v','error','-f',format!,'-i',path,'-f','f64le','-']),expected=decode(reference),actual=decode(join(root,out.slice(1)));expect(actual.length,label).toBe(expected.length);for(let i=0;i<actual.length/8;i++)expect(Math.abs(actual.readDoubleLE(i*8)-expected.readDoubleLE(i*8)),`${label}/${i}`).toBeLessThanOrEqual(filter.includes('aformat=flt')?1e-6:2e-12);
        const handle=await filesystem.openRead(out),options={maxReadBytes:256},audio=format==='wav'?await openWav(handle,options):format==='aiff'?await openAiff(handle,options):await openAu(handle,options);expect(audio.info,label).toMatchObject({channels,sampleRate:outputRate,durationSamples:BigInt(actual.length/(channels*8))});
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches configured empty-input padding with planar format constraints and output packet limits',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-apad-empty-'));
  try{
    writeFileSync(join(root,'input.raw'),new Uint8Array());const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const raw of ['u8','s16le','f64le'])for(const channels of [1,2])for(const filter of ['apad=pad_len=20:packet_size=7','apad=whole_len=20:packet_size=7','aformat=dblp,apad=pad_dur=1ms:packet_size=7,asetrate=11025','asetnsamples=5:p=1,apad=whole_len=10:packet_size=7'])for(const time of [[],['-frames:a','0'],['-ss','0.000125','-frames:a','1']]){
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',filter,...time,'-c:a','pcm_s16le','-bitexact','-f','framecrc'],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${raw}/${channels}/${filter}/${time}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
