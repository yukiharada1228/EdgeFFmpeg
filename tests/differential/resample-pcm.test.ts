import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
function fixture(raw:string,width:number,channels:number){const data=Uint8Array.from({length:257*channels*width},(_,i)=>(i*37+13)&255),view=new DataView(data.buffer);if(raw.startsWith('f'))for(let i=0;i<257*channels;i++){const value=Math.sin(i*.123)+.3*Math.cos(i*.49);if(width===4)view.setFloat32(i*4,value,raw.endsWith('le'));else view.setFloat64(i*8,value,raw.endsWith('le'));}return data;}
it('matches scalar native resampling from all twenty PCM representations into floating output formats',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-pcm-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const formats=[['s8',1],['u8',1],['s16le',2],['s16be',2],['u16le',2],['u16be',2],['s24le',3],['s24be',3],['u24le',3],['u24be',3],['s32le',4],['s32be',4],['u32le',4],['u32be',4],['f32le',4],['f32be',4],['f64le',8],['f64be',8],['alaw',1],['mulaw',1]] as const;
    let index=0;
    for(const [raw,width]of formats)for(const [inputRate,outputRate]of [[8000,16000],[16000,8000]])for(const channels of [1,2]){
      writeFileSync(join(root,'input.raw'),fixture(raw,width,channels));
      for(const target of ['f32le','f32be','f64le','f64be']){
        const before=['-cpuflags','0','-f',raw,'-ar',String(inputRate),'-ac',String(channels)],after=['-ar',String(outputRate),'-f',target],expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        const actual=readFileSync(join(root,out.slice(1))),step=target.startsWith('f32')?4:8,tolerance=raw.startsWith('f64')&&step===8?2e-12:1e-6;expect(actual.length,`${raw}->${target}/${channels}/${inputRate}`).toBe(expected.length);
        const read=(data:Buffer,i:number)=>step===4?(target.endsWith('le')?data.readFloatLE(i*4):data.readFloatBE(i*4)):(target.endsWith('le')?data.readDoubleLE(i*8):data.readDoubleBE(i*8));
        for(let i=0;i<actual.length/step;i++)expect(Math.abs(read(actual,i)-read(expected,i)),`${raw}->${target}/${channels}/${inputRate}/${i}`).toBeLessThanOrEqual(tolerance);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('resamples after same-precision float filters and format-preserving integer FIFO rate filters',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-float-filters-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const [raw,width]of [['f32le',4],['s16le',2],['mulaw',1]] as const)for(const filter of raw==='f32le'?['volume=0.5:precision=float','volume=0.5:precision=float,asetnsamples=7:p=1','volume=0.5:precision=float,asetnsamples=7:p=0,asetrate=11025']:['anull','asetnsamples=7:p=1','asetnsamples=7:p=0,asetrate=11025'])for(const target of ['f32le','f64le']){
      writeFileSync(join(root,'input.raw'),fixture(raw,width,1));const before=['-cpuflags','0','-ss','0.000125','-t','0.02','-f',raw,'-ar','8000','-ac','1'],after=['-af',filter,'-ss','0.0005','-t','0.01','-ar','16001','-f',target];
      const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);const actual=readFileSync(join(root,out.slice(1))),step=target==='f32le'?4:8;expect(actual.length,`${raw}/${filter}`).toBe(expected.length);
      for(let i=0;i<actual.length/step;i++)expect(Math.abs((step===4?actual.readFloatLE(i*4):actual.readDoubleLE(i*8))-(step===4?expected.readFloatLE(i*4):expected.readDoubleLE(i*8))),`${raw}/${filter}/${target}/${i}`).toBeLessThanOrEqual(1e-6);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
