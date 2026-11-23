import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
it('matches native finite apad frame limits and positive sub-sample output durations',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-apad-trim-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    const profiles=[['-frames:a','0'],['-frames:a','1'],['-frames:a','2'],['-frames:a','3'],['-frames:a','-1'],['-frames:a','9223372036854775807'],['-ss','0.000125','-frames:a','2'],['-ss','0.00175','-frames:a','1'],['-ss','0.002625','-t','0.001','-frames:a','2'],['-t','0.000001'],['-ss','0.00175','-t','0.000001'],['-ss','0.002625','-t','0.000001','-frames:a','0'],['-ss','0.002625','-t','0.000001','-frames:a','2']];
    const chains=['apad=pad_len=20:packet_size=7','asetnsamples=5:p=0,apad=pad_len=20:packet_size=7','aformat=dblp,apad=pad_len=20:packet_size=7,asetnsamples=5:p=1','apad=pad_len=5:packet_size=3,apad=pad_len=15:packet_size=7'];
    for(const [raw,width]of [['s16le',2],['f64le',8]] as const)for(const channels of [1,2])for(const filter of chains)for(const time of profiles){
      const data=new Uint8Array(13*channels*width),view=new DataView(data.buffer);for(let i=0;i<13*channels;i++){if(width===2)view.setInt16(i*2,(i*3137)%65536-32768,true);else view.setFloat64(i*8,(i%17-8)/16,true);}writeFileSync(join(root,'input.raw'),data);
      const before=['-cpuflags','0','-f',raw,'-ar','8000','-ac',String(channels)],after=['-af',filter,...time,'-bitexact','-f','framecrc'],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${raw}/${channels}/${filter}/${time.join(' ')}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);

it('limits finite padding frames after multi-packet raw and AIFF input independently of physical chunks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-apad-many-packets-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:258,maxWriteBytes:258}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:258,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const rate of [8000,44100]){
      let span=1;while(span*20<=rate)span*=2;const data=Uint8Array.from({length:(2*span+3)*2},(_,i)=>(i*37+13)&255);writeFileSync(join(root,'input.raw'),data);execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','s16le','-ar',String(rate),'-ac','1','-i',join(root,'input.raw'),'-bitexact',join(root,`input-${rate}.aiff`)]);
      for(const kind of ['raw','aiff'])for(const filter of ['apad=pad_len=20:packet_size=7','asetnsamples=5:p=0,apad=pad_len=20:packet_size=7'])for(const limit of ['1','2','3','4','6'])for(const seek of [[],['-ss','0.000125']]){
        const before=['-cpuflags','0',...(kind==='raw'?['-f','s16le','-ar',String(rate),'-ac','1']:[])],input=kind==='raw'?'input.raw':`input-${rate}.aiff`,after=['-af',filter,...seek,'-frames:a',limit,'-c:a','pcm_s24le','-bitexact','-f','framecrc'];
        const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,input),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i',`/${input}`,...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${rate}/${kind}/${filter}/${limit}/${seek}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
