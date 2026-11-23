import { expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createMediaBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
it('preserves native PCM framecrc while aggregate planning shrinks physical input packets',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-memory-'));
  try{
    writeFileSync(join(root,'input.raw'),Uint8Array.from({length:4000},(_,i)=>(i*37+13)&255));
    const input=['-f','s16le','-ar','8000','-ac','1'],output=['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1,asetrate=20000','-ss','0.001','-frames:a','3','-bitexact','-f','framecrc'];
    const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...input,'-i',join(root,'input.raw'),...output,'-']);
    for(const resident of [1024,65536]){
      const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128});const requests:number[]=[];
      const ffmpeg=new FFmpeg({filesystem:{...filesystem,async openRead(path){const handle=await filesystem.openRead(path);return {...handle,async readAt(offset,length,signal){requests.push(length);return handle.readAt(offset,length,signal);}}; }},backend:createMediaBackend(),budget:{maxResidentBytes:resident,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
      const path=`/${resident}.crc`,result=await ffmpeg.exec([...input,'-i','/input.raw',...output,path]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,path.slice(1)))).toEqual(expected);
      expect(Math.max(...requests)).toBe(resident===1024?24:64);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
