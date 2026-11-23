import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import { openWav } from '@edge-ffmpeg/containers';
import { compileAudioFilterChain } from '@edge-ffmpeg/avfilter';
it('matches constant audio filter chains across six PCM input/output formats against scalar FFmpeg',async()=>{
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string};const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-filters-'));
  const codecs=['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'] as const;
  const chains=['anull','volume=0','volume=0.5','volume=1','volume=2','volume=-1','volume=0.1:precision=double','anull,volume=0.5:precision=double,volume=2:precision=float,anull'];
  try {
    const filesystem=await createNodeFileSystem({root,maxReadBytes:512,maxWriteBytes:512});
    const frontend=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:512,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for(const source of codecs) {
      const width=source==='pcm_u8'?1:source==='pcm_s16le'?2:source==='pcm_s24le'?3:source==='pcm_f64le'?8:4;
      const data=Uint8Array.from({length:width*64},(_,i)=>(i*73+37)&255),view=new DataView(data.buffer);
      if(source==='pcm_f32le'||source==='pcm_f64le')for(let i=0;i<64;i++){const value=i===0?-0:(i-32)/32;if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}
      const raw=source==='pcm_u8'?'u8':source.slice(4),path=join(root,`${source}.raw`);writeFileSync(path,data);
      const wav=join(root,`${source}.wav`);execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f',raw,'-ar','8000','-ac','2','-i',path,'-c:a','copy',wav],{timeout:30000});
      for(const target of codecs)for(const [index,chain]of chains.entries()){
        const targetRaw=target==='pcm_u8'?'u8':target.slice(4);
        const native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-i',wav,'-af',chain,'-c:a',target,'-f',targetRaw,'-'],{timeout:30000});
        const output=`/${source}-${target}-${index}.wav`,result=await frontend.exec(['-cpuflags','0','-i',`/${source}.wav`,'-af',chain,'-c:a',target,output]);
        expect(result.exitCode,JSON.stringify({source,target,chain,diagnostics:result.diagnostics})).toBe(0);
        const actual=await openWav(await filesystem.openRead(output),{maxReadBytes:512});const chunks=[];for await(const packet of actual.packets())chunks.push(packet.data);
        expect(Buffer.concat(chunks).equals(native),`${source}->${target} ${chain}`).toBe(true);
        expect(actual.info.durationSamples).toBe(32n);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches constant dB volume numerically within a declared double-precision tolerance',()=>{
  const data=new Uint8Array(64*8),view=new DataView(data.buffer);for(let i=0;i<64;i++)view.setFloat64(i*8,(i-32)/32,true);
  for(const gain of ['6dB','-6dB','0dB','12dB'])for(const precision of ['float','double']){
    const description=`volume=${gain}:precision=${precision}`;
    const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f','f64le','-ar','8000','-ac','1','-i','pipe:0','-af',description,'-c:a','pcm_f64le','-f','f64le','-'],{input:data,timeout:30000});
    const actual=compileAudioFilterChain(description).apply({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'dbl',samples:64,planes:[data],pts:null},{maxFrameBytes:1024});
    const nativeView=new DataView(expected.buffer,expected.byteOffset,expected.byteLength),actualView=new DataView(actual.planes[0]!.buffer);
    for(let i=0;i<64;i++){
      const result=actual.sampleFormat==='flt'?actualView.getFloat32(i*4,true):actualView.getFloat64(i*8,true),native=nativeView.getFloat64(i*8,true);
      expect(Math.abs(result-native),`${description} sample ${i}`).toBeLessThanOrEqual(Math.max(1,Math.abs(native))*1e-12);
    }
  }
});
it('matches fixed volume quantization clipping and mixed precision negotiation against scalar FFmpeg',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-fixed-volume-'));
  const codecs=['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'] as const;
  const chains=['-1','0','0.001953125','0.005859375','0.5','0.501','0.502','1','2','65535'].map(gain=>`volume=${gain}:precision=fixed`);
  chains.push('volume=0.5:precision=fixed,volume=0.502:precision=fixed','volume=0.5,volume=0.5:precision=fixed','volume=0.5:precision=fixed,volume=0.5:precision=double','volume=0.5:precision=double,volume=0.5:precision=fixed,volume=0.5');
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:64,maxWriteBytes:64});const ffmpeg=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:64,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for(const source of codecs){
      const width=source==='pcm_u8'?1:source==='pcm_s16le'?2:source==='pcm_s24le'?3:source==='pcm_f64le'?8:4;
      const data=Uint8Array.from({length:width*32},(_,i)=>(i*73+37)&255),view=new DataView(data.buffer);
      if(source==='pcm_f32le'||source==='pcm_f64le')for(let i=0;i<32;i++){const value=(i-16)/16;if(width===4)view.setFloat32(i*4,value,true);else view.setFloat64(i*8,value,true);}
      const raw=source.slice(4),path=join(root,`${source}.raw`);writeFileSync(path,data);
      for(const target of codecs)for(const [index,chain]of chains.entries()){
        const targetRaw=target.slice(4),expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac','2','-i',path,'-af',chain,'-f',targetRaw,'-'],{timeout:30000});
        const output=`/${source}-${target}-${index}.raw`,result=await ffmpeg.exec(['-cpuflags','0','-f',raw,'-ar','8000','-ac','2','-i',`/${source}.raw`,'-af',chain,'-f',targetRaw,output]);
        expect(result.exitCode,JSON.stringify({source,target,chain,diagnostics:result.diagnostics})).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${source}->${target} ${chain}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches fixed integer volume over full u8 and s16 domains and s32 boundaries with native dispatch',()=>{
  for(const format of ['u8','s16','s32'] as const){
    const values=format==='u8'?Array.from({length:256},(_,i)=>i):format==='s16'?Array.from({length:65536},(_,i)=>i-32768):[-2147483648,-2147483647,-65537,-257,-256,-255,-3,-2,-1,0,1,2,3,255,256,257,65537,2147483646,2147483647];
    const width=format==='u8'?1:format==='s16'?2:4,data=new Uint8Array(values.length*width),view=new DataView(data.buffer);
    values.forEach((value,i)=>{if(width===1)view.setUint8(i,value);else if(width===2)view.setInt16(i*2,value,true);else view.setInt32(i*4,value,true);});
    const raw=format==='u8'?'u8':format==='s16'?'s16le':'s32le';
    for(const gain of ['0.5','0.502','2','65535']){
      const chain=`volume=${gain}:precision=fixed`,filter=compileAudioFilterChain(chain,{outputSampleFormat:format});expect(filter.requiresScalarRounding(format)).toBe(false);
      const actual=filter.apply({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:format,samples:values.length,planes:[data],pts:null},{maxFrameBytes:data.length});
      for(const flags of [[],['-cpuflags','0']]){
        const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...flags,'-f',raw,'-ar','8000','-ac','1','-i','pipe:0','-af',chain,'-f',raw,'-'],{input:data,timeout:30000});
        expect(Buffer.from(actual.planes[0]!).equals(expected),`${raw} ${chain} ${flags.join(' ')}`).toBe(true);
      }
    }
  }
},30000);
