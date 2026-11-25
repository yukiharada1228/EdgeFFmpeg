import { expect,it } from 'vitest';
import { execFileSync,spawnSync } from 'node:child_process';
import { existsSync,readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createMediaBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
import { openWav } from '@edge-ffmpeg/containers';
import { nativeFrameCountOutcome,referenceNumericProfile } from '../helpers/reference-numeric-profile.js';
const native=resolve('.build/reference/ffmpeg');
it('matches PCM frame-count limits with native packet framing across raw WAV seek and I/O budgets',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-frame-limit-')),numericProfile=referenceNumericProfile();let rejected=0;
  try{
    const frontends=await Promise.all([8,258].map(async budget=>new FFmpeg({filesystem:await createNodeFileSystem({root,maxReadBytes:budget,maxWriteBytes:budget}),backend:createMediaBackend({numericProfile}),budget:{maxResidentBytes:65536,maxBufferBytes:budget,maxCpuTimeMs:1000,maxPendingPackets:2}})));
    for(const rate of [10,8000,44100]){
      let span=1;while(span*20<=rate)span*=2;
      const raw=join(root,`${rate}.raw`),wav=join(root,`${rate}.wav`);writeFileSync(raw,Uint8Array.from({length:(span*3+7)*2},(_,i)=>(i*37+13)&255));
      execFileSync(native,['-v','error','-f','s16le','-ar',String(rate),'-ac','1','-i',raw,wav]);
      for(const kind of ['raw','wav']){
        const declarations=kind==='raw'?['-f','s16le','-ar',String(rate),'-ac','1']:[];
        const scenarios=[{input:[],output:[]},{input:['-ss','0.01'],output:['-ss','0.015']},{input:[],output:['-ss','0.15','-t','0.07']},{input:['-t','0.13'],output:['-ss','0.02']}];
        for(const [index,scenario]of scenarios.entries())for(const count of ['0','1','2','-1','9223372036854775807'])for(const codec of ['copy','pcm_s24le']){
          const file=`${rate}.${kind}`,outputArgs=[...scenario.output,'-frames:a',count,'-c:a',codec,'-bitexact','-f','framecrc'],label=`${rate}/${kind}/${index}/${count}/${codec}`;
          // The reference CPU decides whether native accepts a count whose double is 2^63; Edge follows the same profile.
          const outcome=nativeFrameCountOutcome(numericProfile,'frames:a',count),reference=spawnSync(native,['-v','error',...declarations,...scenario.input,'-i',join(root,file),...outputArgs,'-'],{timeout:30000});
          if(outcome.accepted)expect(reference.status,`${label}: ${String(reference.stderr)}`).toBe(0);else{rejected++;expect(reference.status,label).toBe(outcome.status);expect(String(reference.stderr),label).toContain(outcome.message);expect(reference.stdout.length,label).toBe(0);}
          for(const [budget,ffmpeg]of frontends.entries()){
            const output=`/${rate}-${kind}-${index}-${count}-${codec}-${budget}.crc`,result=await ffmpeg.exec([...declarations,...scenario.input,'-i',`/${file}`,...outputArgs,output]);
            if(outcome.accepted){expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(reference.stdout),`${label}/${budget}`).toBe(true);}
            else{expect(result.exitCode,`${label}/${budget}`).toBe(outcome.status);expect(result.diagnostics.at(-1),`${label}/${budget}`).toEqual({code:'invalid-arguments',message:outcome.message});expect(existsSync(join(root,output.slice(1))),`${label}/${budget}`).toBe(false);}
          }
        }
      }
    }
    expect(rejected).toBe(numericProfile==='linux-x64'?48:0);
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches frame-limit aliases precedence and committed raw WAV output samples',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-frame-alias-'));
  try{
    const data=Uint8Array.from({length:2050},(_,i)=>(i*37)&255);writeFileSync(join(root,'in.raw'),data);
    const filesystem=await createNodeFileSystem({root,maxReadBytes:16,maxWriteBytes:16}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:16,maxCpuTimeMs:1000,maxPendingPackets:2}});
    const limits=[['-frames','1'],['-aframes','2'],['-frames:0','+1'],['-frames:a:0','0'],['-frames:a','1','-aframes','2'],['-aframes','2','-frames','1'],['-frames:a','1','-frames:a','-2']];
    for(const [index,args]of limits.entries())for(const codec of ['copy','pcm_s16le']){
      const input=['-f','s16le','-ar','8000','-ac','1'];const output=['-ss','0.01',...args,'-c:a',codec];
      const expected=execFileSync(native,['-v','error',...input,'-i',join(root,'in.raw'),...output,'-f','s16le','-']);
      for(const format of ['s16le','wav']){
        const path=`/${index}-${codec}-${format}.out`,result=await ffmpeg.exec([...input,'-i','/in.raw',...output,'-f',format,path]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        if(format==='s16le')expect(readFileSync(join(root,path.slice(1)))).toEqual(expected);
        else{
          const wav=await openWav(await filesystem.openRead(path),{maxReadBytes:16}),chunks=[];for await(const packet of wav.packets())chunks.push(packet.data);
          expect(Buffer.concat(chunks)).toEqual(expected);expect(wav.info.durationSamples).toBe(BigInt(expected.length/2));
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
