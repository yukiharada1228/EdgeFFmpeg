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
it('resamples at native mixed-precision volume boundaries with FIFO timing and rate constraints',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-float-filters-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const [raw,width]of [['f32le',4],['f64le',8],['s16le',2],['mulaw',1]] as const)for(const filter of ['volume=0.5:precision=double','volume=0.5:precision=float,volume=0.5:precision=double','volume=0.5:precision=double,asetnsamples=7:p=1','asetrate=11025,volume=0.5:precision=double','volume=0.5:precision=double,asetrate=11025','volume=0.5:precision=fixed,asetnsamples=7:p=1','volume=0.5:precision=float,asetrate=11025,volume=0.5:precision=double','asetnsamples=7:p=1,volume=0.5:precision=double,asetnsamples=5:p=1','volume=0.5:precision=double,volume=0.5:precision=fixed,volume=0.5:precision=float','volume=0.5:precision=float,asetnsamples=7:p=0,volume=0.5:precision=fixed'])for(const target of ['f32le','f64le','s16le']){
      writeFileSync(join(root,'input.raw'),fixture(raw,width,1));const before=['-cpuflags','0','-ss','0.000125','-t','0.02','-f',raw,'-ar','8000','-ac','1'],after=['-af',filter,'-ss','0.0005','-t','0.01','-ar','16001','-f',target];
      const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);const actual=readFileSync(join(root,out.slice(1))),step=target==='f32le'?4:target==='s16le'?2:8;expect(actual.length,`${raw}/${filter}`).toBe(expected.length);
      for(let i=0;i<actual.length/step;i++)expect(Math.abs((step===2?actual.readInt16LE(i*2)/32768:step===4?actual.readFloatLE(i*4):actual.readDoubleLE(i*8))-(step===2?expected.readInt16LE(i*2)/32768:step===4?expected.readFloatLE(i*4):expected.readDoubleLE(i*8))),`${raw}/${filter}/${target}/${i}`).toBeLessThanOrEqual(step===2?1/32768+1e-6:1e-6);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches short stereo mixed-precision draining with multiple rate constraints and FIFO boundaries',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-mixed-short-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    const chains=['asetnsamples=7:p=1,volume=0.5:precision=double,asetnsamples=5:p=1','volume=0.5:precision=double,asetrate=11025,volume=0.5:precision=float,asetrate=12000,volume=0.5:precision=double','volume=0.5:precision=float,asetnsamples=7:p=0,volume=0.5:precision=fixed,asetnsamples=5:p=1'];
    for(const [raw,width]of [['s16le',2],['f32le',4],['f64le',8]] as const)for(const samples of [1,21,24,42,65,257])for(const channels of [1,2])for(const filter of chains)for(const target of ['f64le','s16le']){
      writeFileSync(join(root,'input.raw'),fixture(raw,width,channels).slice(0,samples*channels*width));const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',filter,'-ar','16001','-f',target];
      const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,`${raw}/${samples}/${channels}/${filter}/${target}: ${JSON.stringify(result.diagnostics)}`).toBe(0);const actual=readFileSync(join(root,out.slice(1))),step=target==='s16le'?2:8;expect(actual.length,`${raw}/${samples}/${channels}/${filter}/${target}`).toBe(expected.length);
      for(let i=0;i<actual.length/step;i++){const a=step===2?actual.readInt16LE(i*2)/32768:actual.readDoubleLE(i*8),b=step===2?expected.readInt16LE(i*2)/32768:expected.readDoubleLE(i*8);expect(Math.abs(a-b),`${raw}/${samples}/${channels}/${filter}/${target}/${i}`).toBeLessThanOrEqual(step===2?1/32768+1e-6:1e-6);}
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
