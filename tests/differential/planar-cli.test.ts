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
it('matches CLI planar aformat graphs with automatic rate conversion and trimmed multichannel output',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-resample-float-filters-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:2*1024*1024,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const [raw,width]of [['f32le',4],['f64le',8],['s16le',2],['mulaw',1]] as const)for(const filter of ['aformat=fltp','aformat=dblp,asetnsamples=7:p=1','aformat=s16p','volume=0.5:precision=fixed,aformat=s16p','aformat=fltp,volume=0.5:precision=fixed,aformat=dblp','aformat=dblp,asetrate=11025,aformat=fltp','asetnsamples=7:p=1,aformat=dblp,asetnsamples=5:p=1'])for(const channels of [1,2])for(const target of ['f32le','f64le','s16le']){
      writeFileSync(join(root,'input.raw'),fixture(raw,width,channels));const before=['-cpuflags','0','-ss','0.000125','-t','0.02','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',filter,'-ss','0.0005','-t','0.01','-ar','16001','-f',target];
      const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.raw`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);const actual=readFileSync(join(root,out.slice(1))),step=target==='f32le'?4:target==='s16le'?2:8;expect(actual.length,`${raw}/${filter}`).toBe(expected.length);
      for(let i=0;i<actual.length/step;i++)expect(Math.abs((step===2?actual.readInt16LE(i*2)/32768:step===4?actual.readFloatLE(i*4):actual.readDoubleLE(i*8))-(step===2?expected.readInt16LE(i*2)/32768:step===4?expected.readFloatLE(i*4):expected.readDoubleLE(i*8))),`${raw}/${filter}/${target}/${i}`).toBeLessThanOrEqual(step===2?1/32768+1e-6:1e-6);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches CLI planar constraints FIFO and fixed-volume timing without rate conversion byte for byte',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-aformat-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const [raw,width]of [['u8',1],['s16le',2],['s32le',4],['f32le',4],['f64le',8]] as const)for(const format of ['u8p','s16p','s32p','fltp','dblp'])for(const fixed of [false,true]){
      writeFileSync(join(root,'input.raw'),fixture(raw,width,1));const filter=`${fixed?'volume=0.5:precision=fixed,':''}aformat=sample_fmts=${format},asetnsamples=7:p=1`,before=['-cpuflags','0','-f',raw,'-ar','8000','-ac','1'],after=['-af',filter,'-c:a','pcm_s16le','-bitexact','-f','framecrc'];
      const expected=execFileSync(native,['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${raw}/${format}/${fixed}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
