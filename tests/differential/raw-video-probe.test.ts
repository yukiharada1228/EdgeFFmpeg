import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
it('matches rawvideo probe packet duration transitions and input seek buffer flushing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-video-probe-'));
 try{
  const filesystem=await createNodeFileSystem({root,maxReadBytes:320000,maxWriteBytes:320000}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:4000000,maxBufferBytes:320000,maxPendingPackets:2,maxCpuTimeMs:10000}});let index=0;
  for(const [size,bytes,frames]of [['3x2',6,200],['800x400',320000,18]] as const){
   writeFileSync(join(root,'input.raw'),Uint8Array.from({length:bytes*frames},(_,i)=>(i*37+13)&255));
   for(const rate of ['999','1000','1500','2000','1001000'])for(const inputTime of [[],['-ss','0'],['-ss','0.000001']])for(const outputTime of [[],['-ss','0.025']]){
    const before=[...inputTime,'-f','rawvideo','-pixel_format','gray','-video_size',size,'-framerate',rate],after=['-c:v','copy',...outputTime,'-bitexact','-f','framecrc'],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]),label=`${size}/${rate}/${inputTime}/${outputTime}`;
    expect(result.exitCode,`${label}: ${JSON.stringify(result.diagnostics)}`).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),label).toBe(true);
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
