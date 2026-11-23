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
it('matches CLI double resampling counts samples container metadata and scoped timing against scalar native',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-cli-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    let index=0;
    for(const [inputRate,outputRate]of [[8000,16000],[16000,8000],[44100,48001],[48001,44100]])for(const channels of [1,2]){
      const input=new Uint8Array(257*channels*8),view=new DataView(input.buffer);for(let i=0;i<257*channels;i++)view.setFloat64(i*8,Math.sin(i*.123)+.2*Math.cos(i*.49),true);writeFileSync(join(root,'input.raw'),input);
      for(const [format,codec]of [['f64le','pcm_f64le'],['wav','pcm_f64le'],['aiff','pcm_f64be'],['au','pcm_f64be']])for(const timed of [false,true]){
        const before=['-cpuflags','0',...(timed?['-ss',String(1/inputRate!)]:[]),'-f','f64le','-ar',String(inputRate),'-ac',String(channels)],after=[...(timed?['-ss','0.0005','-t','0.002']:[]),'-ar',String(outputRate),'-c:a',codec!,'-bitexact','-f',format!],base=String(index++),output=`/${base}.out`,reference=join(root,`${base}.native`);
        execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,reference]);
        const result=await frontend.exec([...before,'-i','/input.raw',...after,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        const decode=(path:string)=>execFileSync(native,['-v','error',...(format==='f64le'?['-f','f64le','-ar',String(outputRate),'-ac',String(channels)]:[]),'-i',path,'-f','f64le','-']);
        const expected=decode(reference),actual=decode(join(root,output.slice(1)));expect(actual.length,`${inputRate}->${outputRate}/${channels}/${format}/${timed}`).toBe(expected.length);
        for(let i=0;i<actual.length/8;i++)expect(Math.abs(actual.readDoubleLE(i*8)-expected.readDoubleLE(i*8)),`${base}/${i}`).toBeLessThanOrEqual(2e-12);
        if(format!=='f64le'){const handle=await filesystem.openRead(output),options={maxReadBytes:128},opened=format==='wav'?await openWav(handle,options):format==='aiff'?await openAiff(handle,options):await openAu(handle,options);expect(opened.info).toMatchObject({channels,sampleRate:outputRate,durationSamples:BigInt(actual.length/(channels*8))});}
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('resamples after double precision filters FIFO padding and asetrate with input duration',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-filters-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const input=new Uint8Array(260*8),view=new DataView(input.buffer);for(let i=0;i<260;i++)view.setFloat64(i*8,((i*3137)%65536-32768)/32768,true);writeFileSync(join(root,'input.raw'),input);
    for(const [index,filter]of ['volume=0.5:precision=double','volume=0.5:precision=double,asetnsamples=7:p=1','volume=0.5:precision=double,asetnsamples=7:p=0,asetrate=11025'].entries()){
      const before=['-cpuflags','0','-ss','0.000125','-t','0.02','-f','f64le','-ar','8000','-ac','1'],after=['-af',filter,'-ss','0.0005','-t','0.01','-ar','16000','-f','f64le'];
      const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);const actual=readFileSync(join(root,out.slice(1)));expect(actual.length,filter).toBe(expected.length);
      for(let i=0;i<actual.length/8;i++)expect(Math.abs(actual.readDoubleLE(i*8)-expected.readDoubleLE(i*8)),`${filter}/${i}`).toBeLessThanOrEqual(2e-12);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('resamples auto-detected floating containers and finite short sources with exact output counts',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-inputs-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    let index=0;
    for(const samples of [1,21,24,42,65,513])for(const [inputRate,outputRate]of [[8000,16000],[48001,44100]])for(const [format,codec]of [['wav','pcm_f64le'],['aiff','pcm_f64be'],['au','pcm_f64be']]){
      const data=new Uint8Array(samples*8),view=new DataView(data.buffer);for(let i=0;i<samples;i++)view.setFloat64(i*8,(i%11-5)/8,true);writeFileSync(join(root,'input.raw'),data);
      const id=String(index++),source=join(root,`${id}.input`);execFileSync(native,['-v','error','-f','f64le','-ar',String(inputRate),'-ac','1','-i',join(root,'input.raw'),'-c:a',codec!,'-f',format!,source]);
      const expected=execFileSync(native,['-v','error','-cpuflags','0','-f',format!,'-i',source,'-ar',String(outputRate),'-f','f64le','-']),out=`/${id}.out`,result=await frontend.exec(['-cpuflags','0','-i',`/${id}.input`,'-ar',String(outputRate),'-f','f64le',out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      const actual=readFileSync(join(root,out.slice(1)));expect(actual.length,`${samples}/${inputRate}->${outputRate}/${format}`).toBe(expected.length);for(let i=0;i<actual.length/8;i++)expect(Math.abs(actual.readDoubleLE(i*8)-expected.readDoubleLE(i*8))).toBeLessThanOrEqual(2e-12);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
