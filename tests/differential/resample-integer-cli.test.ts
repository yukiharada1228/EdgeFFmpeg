import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {openWav,openAiff,openAu} from '@edge-ffmpeg/containers';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
const formats=[['s8',1],['u8',1],['s16le',2],['s16be',2],['u16le',2],['u16be',2],['s24le',3],['s24be',3],['u24le',3],['u24be',3],['s32le',4],['s32be',4],['u32le',4],['u32be',4],['f32le',4],['f32be',4],['f64le',8],['f64be',8],['alaw',1],['mulaw',1]] as const;
function fixture(raw:string,width:number,channels:number){const data=Uint8Array.from({length:129*channels*width},(_,i)=>(i*37+13)&255),view=new DataView(data.buffer);if(raw.startsWith('f'))for(let i=0;i<129*channels;i++){const value=Math.sin(i*.123)+.3*Math.cos(i*.49);if(width===4)view.setFloat32(i*4,value,raw.endsWith('le'));else view.setFloat64(i*8,value,raw.endsWith('le'));}return data;}
it.each(formats)('matches native rate conversion from %s across all twenty raw target formats',async(raw,width)=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-integer-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0,different=0;
    for(const [inputRate,outputRate]of [[8000,16000],[16000,8000]])for(const channels of [1,2]){
      writeFileSync(join(root,'input.raw'),fixture(raw,width,channels));
      for(const [target,targetWidth]of formats){
        const before=['-cpuflags','0','-f',raw,'-ar',String(inputRate),'-ac',String(channels)],after=['-ar',String(outputRate),'-f',target],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);const actual=readFileSync(join(root,out.slice(1)));expect(actual.length,`${raw}->${target}/${channels}/${inputRate}`).toBe(expected.length);
        if(actual.equals(expected))continue;different++;
        const decode=(data:Buffer)=>execFileSync(native,['-v','error','-cpuflags','0','-f',target,'-ar',String(outputRate),'-ac',String(channels),'-i','pipe:0','-f','f64le','-'],{input:data}),a=decode(actual),b=decode(expected);
        const integer=!target.startsWith('f')&&!['alaw','mulaw'].includes(target),step=integer?2**-(targetWidth*8-1):0,tolerance=(raw.startsWith('f64')?2e-12:1e-6)+step;
        for(let i=0;i<a.length/8;i++)expect(Math.abs(a.readDoubleLE(i*8)-b.readDoubleLE(i*8)),`${raw}->${target}/${channels}/${inputRate}/${i}`).toBeLessThanOrEqual(tolerance);
      }
    }
    expect(index).toBe(80);
    console.info(`Raw resampling ${raw}: ${index} cases; ${different} numerically compared non-identical outputs`);
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches default native fixed profiles for every u8 codeword and signed16-to-u8 full-domain input',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-fixed-cli-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    const full=new Uint8Array(65536*2),view=new DataView(full.buffer);for(let i=0;i<65536;i++)view.setInt16(i*2,i-32768,true);
    for(const source of ['u8','s16le'])for(const [inputRate,outputRate]of [[8000,16000],[16000,8000]]){
      const data=source==='u8'?Uint8Array.from({length:256},(_,i)=>i):full;writeFileSync(join(root,'input.raw'),data);
      for(const target of source==='u8'?['u8','s8','s16le','s16be']:['u8']){
        const before=['-cpuflags','0','-f',source,'-ar',String(inputRate),'-ac','1'],after=['-ar',String(outputRate),'-f',target],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1)))).toEqual(expected);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches integer container defaults rate metadata and filtered timing after resampling',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-integer-containers-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const [raw,width]of [['u8',1],['s16le',2],['f32le',4]] as const)for(const [inputRate,outputRate]of [[8000,16001],[48001,44100]])for(const channels of [1,2])for(const format of ['wav','aiff','au'])for(const filter of raw==='f32le'?['anull','asetnsamples=7:p=1','asetrate=11025']:['anull','asetnsamples=7:p=1','asetrate=11025','volume=0.5:precision=fixed','volume=0.5:precision=fixed,asetnsamples=7:p=1']){
      writeFileSync(join(root,'input.raw'),fixture(raw,width,channels));const before=['-cpuflags','0','-ss','0.000125','-t','0.01','-f',raw,'-ar',String(inputRate),'-ac',String(channels)],after=['-af',filter,'-ss','0.0005','-t','0.002','-ar',String(outputRate),'-bitexact','-f',format],id=String(index++),expectedFile=join(root,`${id}.native`),out=`/${id}.${format}`;
      execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,expectedFile]);const result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      const handle=await filesystem.openRead(out),options={maxReadBytes:128},audio=format==='wav'?await openWav(handle,options):format==='aiff'?await openAiff(handle,options):await openAu(handle,options);expect(audio.info).toMatchObject({sampleRate:outputRate,channels,codec:format==='wav'?'pcm_s16le':'pcm_s16be'});
      const decode=(path:string)=>execFileSync(native,['-v','error','-i',path,'-f','s16le','-']),actual=decode(join(root,out.slice(1))),expected=decode(expectedFile);expect(actual.length,`${raw}/${format}/${filter}`).toBe(expected.length);expect(audio.info.durationSamples).toBe(BigInt(actual.length/(channels*2)));for(let i=0;i<actual.length/2;i++)expect(Math.abs(actual.readInt16LE(i*2)-expected.readInt16LE(i*2))).toBeLessThanOrEqual(1);
      if(raw==='u8')expect(readFileSync(join(root,out.slice(1)))).toEqual(readFileSync(expectedFile));
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
