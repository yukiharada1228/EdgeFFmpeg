import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import { decodePcm, encodePcm } from '@edge-ffmpeg/avcodec';
it('matches 36 PCM sample-format pairs against the scalar native profile', async () => {
  const metadata = JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};
  const lock = JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string}; expect(metadata.commit).toBe(lock.commit);
  const root = mkdtempSync(join(tmpdir(),'edgeffmpeg-formats-'));
  const codecs = ['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'] as const;
  try {
    const filesystem = await createNodeFileSystem({root,maxReadBytes:1024,maxWriteBytes:1024});
    const ffmpeg = new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:1024,maxCpuTimeMs:1000,maxPendingPackets:2}});
    for (const source of codecs) {
      const width = source === 'pcm_u8' ? 1 : source === 'pcm_s16le' ? 2 : source === 'pcm_s24le' ? 3 : source === 'pcm_f64le' ? 8 : 4;
      const bytes = Uint8Array.from({length:width*256},(_,i)=>(i*73+37)&255), view = new DataView(bytes.buffer);
      if (source === 'pcm_f32le' || source === 'pcm_f64le') {
        const boundaries = [-32768,-2,-1,-0.5,-1.5/32768,-0.5/32768,0,0.5/32768,1.5/32768,0.5,1,2,32768];
        for (let i=0;i<256;i++) { const value=i<boundaries.length ? boundaries[i]! : (i-128)/128; if(width===4)view.setFloat32(i*width,value,true);else view.setFloat64(i*width,value,true); }
      }
      const raw = source==='pcm_u8'?'u8':source.slice(4), path=join(root,`${source}.raw`); writeFileSync(path,bytes);
      execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f',raw,'-ar','8000','-ac','2','-i',path,'-c:a','copy',join(root,`${source}.wav`)],{timeout:30000});
      const frame = decodePcm({streamIndex:0,data:bytes,pts:0n,dts:0n,duration:128n,timeBase:{num:1n,den:8000n},flags:1},{codec:source,channels:2,sampleRate:8000},{maxFrameBytes:4096});
      for (const target of codecs) {
        const targetRaw=target==='pcm_u8'?'u8':target.slice(4);
        const expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f',raw,'-ar','8000','-ac','2','-i',path,'-c:a',target,'-f',targetRaw,'-'],{timeout:30000});
        expect(Buffer.from(encodePcm(frame,target,{maxFrameBytes:4096}).data),`${source}->${target}`).toEqual(expected);
        if (!source.startsWith('pcm_f') || target.startsWith('pcm_f')) {
          const defaultOutput=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f',raw,'-ar','8000','-ac','2','-i',path,'-c:a',target,'-f',targetRaw,'-'],{timeout:30000});
          expect(defaultOutput,`default dispatch ${source}->${target}`).toEqual(expected);
        }

        const result=await ffmpeg.exec(['-cpuflags','0','-i',`/${source}.wav`,'-c:a',target,`/${source}-${target}.wav`]);
        expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        const actual=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-i',join(root,`${source}-${target}.wav`),'-c:a','copy','-f',targetRaw,'-'],{timeout:30000});
        expect(actual,`CLI ${source}->${target}`).toEqual(expected);
      }
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
it('compares scalar half-way rounding with the default native dispatch', () => {
  const data = new Uint8Array(35 * 4), view = new DataView(data.buffer);
  const pattern = [-1.5,-1,-0.5,0,0.5,1,1.5];
  for(let i=0;i<35;i++) view.setFloat32(i*4,pattern[i%7]!/32768,true);
  const run = (flags: string[]) => execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...flags,'-f','f32le','-ar','8000','-ac','1','-i','pipe:0','-c:a','pcm_s16le','-f','s16le','pipe:1'],{input:data,timeout:30000});
  const scalar=run(['-cpuflags','0']), native=run([]);
  const values=(bytes:Uint8Array)=>{const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return Array.from({length:bytes.length/2},(_,i)=>v.getInt16(i*2,true));};
  expect(values(scalar)).toEqual(Array.from({length:35},(_,i)=>[-2,-1,0,0,0,1,2][i%7]));
  expect(native.length).toBe(scalar.length);
  console.info('Native rounding dispatch observation', JSON.stringify({platform:process.platform,arch:process.arch,scalar:values(scalar),default:values(native),identical:scalar.equals(native)}));
});
