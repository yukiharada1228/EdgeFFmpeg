import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
import { openWav } from '@edge-ffmpeg/containers';
const scenarios: Array<{input?:string[];output?:string[]}> = [
  {},{input:['-ss','0.01']},{input:['-ss','0.05']},{input:['-ss','0.15']},{input:['-ss','0.199999']},
  {output:['-ss','0.01']},{output:['-ss','0.05']},{output:['-ss','0.15']},{output:['-ss','0.199999']},
  {output:['-t','0']},{output:['-t','0.000001']},{output:['-t','0.049999']},{output:['-t','0.15']},{output:['-t','0.31']},
  {input:['-t','0']},{input:['-t','0.000001']},{input:['-t','0.049999']},{input:['-t','0.31']},{input:['-ss','0.15','-t','0.31']},
  {input:['-ss','0.05'],output:['-ss','0.05','-t','0.31']},{input:['-ss','0.14'],output:['-ss','0.14']},
  {input:['-t','0.31'],output:['-ss','0.15']},{input:['-t','0.31'],output:['-t','0.2']},
  {input:['-ss','150ms'],output:['-t','350000us']},{input:['-ss','0:0.15'],output:['-to','0:0.5']},
  {input:['-ss','0.15','-to','0.5']},{output:['-ss','0.15','-to','0.5']},
  {output:['-ss','0.15','-t','0.31','-to','0.1']},{output:['-ss','0.1','-ss','0.15','-t','0.31']},
  {output:['-ss','0.01','-t','0.000001']},{input:['-ss','0.05'],output:['-ss','0.01','-t','0.000001']},{input:['-t','0.000001'],output:['-ss','0.15']},
  {output:['-ss','10000']}
];
it('matches scoped PCM WAV input/output seeks and duration bounds against native FFmpeg', async () => {
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string};
  const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-time-'));
  try {
    const fs=await createNodeFileSystem({root,maxReadBytes:512,maxWriteBytes:512});
    const frontend=new FFmpeg({filesystem:fs,backend:createWavBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:512,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for(const rate of [10,8000,44100]) {
      const count=Math.max(30,rate*3);
      const bytes=new Uint8Array(count*2), view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,(i*257)%65536-32768,true);
      const path=join(root,`input-${rate}.raw`), wav=join(root,`input-${rate}.wav`);writeFileSync(path,bytes);
      execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','s16le','-ar',String(rate),'-ac','1','-i',path,'-c:a','copy',wav],{timeout:30000});
      for(const [index,scenario] of scenarios.entries()) for(const codec of ['copy','pcm_s16le']) {
        const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...(scenario.input??[]),'-i',wav,...(scenario.output??[]),'-c:a',codec,'-f','s16le','-'],{timeout:30000});
        const output=`/out-${rate}-${index}-${codec}.wav`;
        const result=await frontend.exec([...(scenario.input??[]),'-i',`/input-${rate}.wav`,...(scenario.output??[]),'-c:a',codec,output]);
        expect(result.exitCode,JSON.stringify({rate,scenario,codec,diagnostics:result.diagnostics})).toBe(0);
        const actual=await openWav(await fs.openRead(output),{maxReadBytes:512}); const packets=[];for await(const packet of actual.packets())packets.push(packet.data);
        expect(Buffer.concat(packets).equals(expected),JSON.stringify({rate,scenario,codec,actualSamples:actual.info.durationSamples.toString(),expectedSamples:expected.length/2})).toBe(true);
        expect(actual.info.durationSamples).toBe(BigInt(expected.length/2));
      }
    }
  } finally {rmSync(root,{recursive:true,force:true});}
},30000);

it('records native input-seek EOF fallback and rejects the unimplemented profile without output', async () => {
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-eof-seek-'));
  try {
    const bytes=new Uint8Array(10000), view=new DataView(bytes.buffer);for(let i=0;i<5000;i++)view.setInt16(i*2,i,true);
    const raw=join(root,'input.raw'), wav=join(root,'input.wav');writeFileSync(raw,bytes);
    execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','s16le','-ar','44100','-ac','1','-i',raw,'-c:a','copy',wav],{timeout:30000});
    const native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-ss','0.15','-i',wav,'-c:a','copy','-f','s16le','-'],{timeout:30000});
    const filesystem=await createNodeFileSystem({root,maxReadBytes:512,maxWriteBytes:512});
    const result=await new FFmpeg({filesystem,backend:createWavBackend()}).exec(['-ss','0.15','-i','/input.wav','-c:a','copy','/output.wav']);
    expect(result.exitCode).toBe(1);expect(result.diagnostics[0]?.code).toBe('unsupported-seek');expect(result.outputs).toEqual([]);
    const {readdirSync}=await import('node:fs');expect(readdirSync(root).sort()).toEqual(['input.raw','input.wav']);
    console.info('Known native EOF seek fallback',JSON.stringify({platform:process.platform,arch:process.arch,requestedMicroseconds:150000,nativeOutputSamples:native.length/2,edgeStatus:'unsupported-seek',limitation:'Native fallback depends on AVIO buffer/seek state; no compatibility claimed'}));
  } finally {rmSync(root,{recursive:true,force:true});}
});
