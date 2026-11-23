import { expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createMediaBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
const native=resolve('.build/reference/ffmpeg');
it('matches stateful PCM reframing padding timing and packet limits against native FFmpeg',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-asetnsamples-'));
  try{
    const frontends=await Promise.all([128,512].map(async budget=>new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget}),backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:budget,maxCpuTimeMs:1000,maxPendingPackets:2}})));
    for(const [raw,width]of [['u8',1],['s16le',2],['s24le',3],['s32le',4],['f32le',4],['f64le',8]] as const){
      const data=Uint8Array.from({length:29*2*width},(_,i)=>(i*37+13)&255),view=new DataView(data.buffer);
      if(raw==='f32le'||raw==='f64le')for(let i=0;i<58;i++){if(width===4)view.setFloat32(i*4,(i-29)/32,true);else view.setFloat64(i*8,(i-29)/32,true);}
      const input=join(root,`${raw}.raw`);writeFileSync(input,data);
      const chains=['asetnsamples=3:p=1','asetnsamples=n=3:pad=false','asetnsamples=7:p=1','asetnsamples=3:p=1,asetnsamples=7:p=0','volume=0.5:precision=fixed,asetnsamples=7:p=1,asetrate=11025'];
      const scenarios=[{input:[],output:[]},{input:[],output:['-ss','0.0005']},{input:[],output:['-t','0.0011']},{input:[],output:['-ss','0.0005','-frames:a','2']},{input:['-ss','0.000125','-t','0.00175'],output:[]},{input:[],output:['-t','0.000001']},{input:[],output:['-ss','0.0005','-t','0.0011']},{input:[],output:['-to','0.0011','-ss','0.0005']},{input:[],output:['-ss','0.00375']},{input:[],output:['-frames:a','0']}];
      for(const [filterIndex,filter]of chains.entries())for(const [index,scenario]of scenarios.entries()){
        const args=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2',...scenario.input],outputArgs=[...scenario.output,'-af',filter,'-c:a',`pcm_${raw}`,'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...args,'-i',input,...outputArgs,'-'],{timeout:30000});
        for(const [budget,ffmpeg]of frontends.entries()){
          const output=`/${raw}-${filterIndex}-${index}-${budget}.crc`,result=await ffmpeg.exec([...args,'-i',`/${raw}.raw`,...outputArgs,output]);
          expect(result.exitCode,JSON.stringify({raw,filter,index,diagnostics:result.diagnostics})).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${raw}/${filterIndex}/${index}/${budget}`).toBe(true);
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);

it('matches padded WAV raw payloads aliases default size and sample-count metadata',async()=>{
  const {openWav}=await import('@edge-ffmpeg/containers');
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-asetnsamples-output-'));
  try{
    writeFileSync(join(root,'input.raw'),new Uint8Array([0,128,255,130,127]));
    const filesystem=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:4096,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for(const [index,filter]of ['asetnsamples','asetnsamples=nb_out_samples=3:pad=true','asetnsamples=3:p=0','asetnsamples=3:p=1,asetnsamples=4:p=1'].entries()){
      const input=['-f','u8','-ar','8000','-ac','1'];
      const expected=execFileSync(native,['-v','error',...input,'-i',join(root,'input.raw'),'-af',filter,'-f','u8','-']);
      for(const format of ['u8','wav']){
        const output=`/${index}-${format}.out`,result=await ffmpeg.exec([...input,'-i','/input.raw','-af',filter,'-c:a','pcm_u8','-f',format,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        if(format==='u8')expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
        else{const wav=await openWav(await filesystem.openRead(output),{maxReadBytes:4096}),chunks=[];for await(const packet of wav.packets())chunks.push(packet.data);expect(wav.info.durationSamples).toBe(BigInt(expected.length));expect(Buffer.concat(chunks)).toEqual(expected);}
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
