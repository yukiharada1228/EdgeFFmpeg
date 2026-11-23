import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
it('matches native duration apad rounding and rate-sensitive packet sections',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-apad-cli-'));
  try{
    let index=0;for(const budget of [128,512]){
      const filesystem=await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:budget,maxPendingPackets:2,maxCpuTimeMs:1000}});
      for(const [raw,width]of [['u8',1],['s16le',2],['f64le',8]] as const)for(const rate of [8000,11025])for(const channels of [1,2])for(const filter of ['apad=pad_dur=0','apad=pad_dur=62us:packet_size=7','apad=pad_dur=63us:packet_size=7','apad=pad_dur=2ms:packet_size=7','apad=whole_dur=1ms:packet_size=7','apad=whole_dur=2ms:packet_size=7','asetrate=20000,apad=pad_dur=0.0005:packet_size=7','apad=pad_dur=0.0005:packet_size=7,asetrate=20000','asetnsamples=5:p=1,apad=whole_dur=2ms:packet_size=7','aformat=dblp,apad=pad_dur=63us:packet_size=7,apad=whole_dur=2ms:packet_size=7']){
        const data=new Uint8Array(13*channels*width),view=new DataView(data.buffer);for(let i=0;i<13*channels;i++){if(width===1)view.setUint8(i,(i*37)&255);else if(width===2)view.setInt16(i*2,(i*3137)%65536-32768,true);else view.setFloat64(i*8,(i%17-8)/16,true);}writeFileSync(join(root,'input.raw'),data);
        const before=['-cpuflags','0','-f',raw,'-ar',String(rate),'-ac',String(channels)],after=['-af',filter,'-bitexact','-f','framecrc'],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${raw}/${channels}/${budget}/${filter}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
