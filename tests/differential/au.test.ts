import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openAu} from '@edge-ffmpeg/containers';
const native=resolve('.build/reference/ffmpeg');
const codecs=['pcm_s8','pcm_s16be','pcm_s24be','pcm_s32be','pcm_f32be','pcm_f64be','pcm_alaw','pcm_mulaw'];
it('matches native AU files and auto-detected decode for eight codecs rates and channel counts',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-au-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    for(const channels of [1,2])for(const rate of [10,8000,44100]){
      const input=new Uint8Array(67*channels*2),view=new DataView(input.buffer);for(let i=0;i<67*channels;i++)view.setInt16(i*2,(i*3137)%65536-32768,true);writeFileSync(join(root,'input.raw'),input);
      for(const codec of codecs){
        const name=`${codec}-${rate}-${channels}`,tail=['-c:a',codec,'-bitexact','-f','au'],args=['-f','s16le','-ar',String(rate),'-ac',String(channels),'-i'];
        execFileSync(native,['-v','error',...args,join(root,'input.raw'),...tail,join(root,`${name}-native.au`)]);
        const result=await ffmpeg.exec([...args,'/input.raw',...tail,`/${name}.au`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,`${name}.au`))).toEqual(readFileSync(join(root,`${name}-native.au`)));
        const info=(await openAu(await filesystem.openRead(`/${name}.au`),{maxReadBytes:128})).info;expect(info).toMatchObject({codec,channels,sampleRate:rate,durationSamples:67n,dataOffset:32n});
        const decoded=await ffmpeg.exec(['-cpuflags','0','-i',`/${name}-native.au`,'-f','s16le',`/${name}.raw`]);expect(decoded.exitCode,JSON.stringify(decoded.diagnostics)).toBe(0);
        const expected=execFileSync(native,['-v','error','-cpuflags','0','-i',join(root,`${name}-native.au`),'-f','s16le','-']);expect(readFileSync(join(root,`${name}.raw`))).toEqual(expected);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches AU native packet timing copy seek duration FIFO and EOF handling',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-au-timing-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const source=new Uint8Array(4300*4),view=new DataView(source.buffer);for(let i=0;i<8600;i++)view.setInt16(i*2,(i*3137)%65536-32768,true);writeFileSync(join(root,'input.raw'),source);
    for(const codec of codecs){
      const path=join(root,`${codec}.au`);execFileSync(native,['-v','error','-f','s16le','-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a',codec,'-bitexact',path]);
      const profiles=[{before:[],after:[]},{before:['-ss','0.000125'],after:['-ss','0.001','-t','0.02']},{before:[],after:['-frames:a','2']},{before:['-ss','0.5375'],after:[]},{before:['-ss','1'],after:[]}];
      for(const [index,profile]of profiles.entries())for(const copy of [true,false]){
        const before=['-cpuflags','0',...profile.before],after=[...profile.after,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1,asetrate=11025','-c:a','pcm_s16be']),'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...before,'-i',path,...after,'-']),out=`/${codec}-${index}-${copy}.crc`,result=await ffmpeg.exec([...before,'-i',`/${codec}.au`,...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${codec}/${index}/${copy}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('decodes finite unknown-length AU and skips annotations with explicit native format selection',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-au-annotation-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:8,maxWriteBytes:8}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const data=new Uint8Array(4102),view=new DataView(data.buffer);[0x2e736e64,4096,0xffffffff,3,8000,1].forEach((value,i)=>view.setUint32(i*4,value,false));data.set([128,0,0,0,127,255],4096);writeFileSync(join(root,'input.au'),data);
    const expected=execFileSync(native,['-v','error','-f','au','-i',join(root,'input.au'),'-f','s16le','-']);
    const result=await ffmpeg.exec(['-f','au','-i','/input.au','-f','s16le','/output.raw']);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,'output.raw'))).toEqual(expected);
  }finally{rmSync(root,{recursive:true,force:true});}
});
