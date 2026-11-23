import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { decodeG711,encodeG711 } from '@edge-ffmpeg/avcodec';
it('matches all G711 codewords and the complete signed16 encoder domain against native FFmpeg',()=>{
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string};const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  const golden=JSON.parse(readFileSync('compat/behavior-specs/g711-domains.json','utf8')) as {upstreamCommit:string;cases:Record<string,{decodedSha256:string;encodedSha256:string}>};expect(golden.upstreamCommit).toBe(lock.commit);
  const native=resolve('.build/reference/ffmpeg'),codes=Uint8Array.from({length:256},(_,i)=>i),linear=new Uint8Array(65536*2),view=new DataView(linear.buffer);
  for(let i=0;i<65536;i++)view.setInt16(i*2,i-32768,true);
  for(const [codec,format]of [['pcm_alaw','alaw'],['pcm_mulaw','mulaw']] as const){
    const decoded=decodeG711({streamIndex:0,data:codes,pts:0n,dts:0n,duration:256n,timeBase:{num:1n,den:8000n},flags:1},{codec,channels:1,sampleRate:8000},{maxFrameBytes:512});
    const expected=execFileSync(native,['-v','error','-f',format,'-ar','8000','-ac','1','-i','pipe:0','-f','s16le','-'],{input:codes,timeout:30000});expect(Buffer.from(decoded.planes[0]!)).toEqual(expected);expect(createHash('sha256').update(expected).digest('hex')).toBe(golden.cases[codec]!.decodedSha256);
    const scalarDecoded=execFileSync(native,['-v','error','-cpuflags','0','-f',format,'-ar','8000','-ac','1','-i','pipe:0','-f','s16le','-'],{input:codes,timeout:30000});expect(Buffer.from(decoded.planes[0]!)).toEqual(scalarDecoded);
    const packet=encodeG711({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:65536,planes:[linear],pts:null},codec,{maxFrameBytes:linear.length});
    const encoded=execFileSync(native,['-v','error','-f','s16le','-ar','8000','-ac','1','-i','pipe:0','-c:a',codec,'-f',format,'-'],{input:linear,timeout:30000});
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(golden.cases[codec]!.encodedSha256);
    const scalarEncoded=execFileSync(native,['-v','error','-cpuflags','0','-f','s16le','-ar','8000','-ac','1','-i','pipe:0','-c:a',codec,'-f',format,'-'],{input:linear,timeout:30000});expect(Buffer.from(packet.data)).toEqual(scalarEncoded);
    const differences=[];for(let i=0;i<65536;i++)if(packet.data[i]!==encoded[i])differences.push({sample:i-32768,actual:packet.data[i],expected:encoded[i]});expect(differences.slice(0,20),`${codec}: ${differences.length} mismatches`).toEqual([]);
  }
},30000);

it('matches CLI G711 and linear PCM conversion matrices including raw defaults and framecrc timing',async()=>{
  const {FFmpeg}=await import('@edge-ffmpeg/core');const {createMediaBackend}=await import('@edge-ffmpeg/avformat');const {createNodeFileSystem}=await import('@edge-ffmpeg/runtime-node');
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-g711-cli-'));
  try{
    const native=resolve('.build/reference/ffmpeg'),filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const formats=[['u8',1],['s16le',2],['s24le',3],['s32le',4],['f32le',4],['f64le',8],['alaw',1],['mulaw',1]] as const;
    for(const [raw,width]of formats){
      const data=Uint8Array.from({length:raw==='alaw'||raw==='mulaw'?256:width*64},(_,i)=>raw==='alaw'||raw==='mulaw'?i:(i*37+13)&255),view=new DataView(data.buffer);
      if(raw==='f32le'||raw==='f64le')for(let i=0;i<64;i++){if(width===4)view.setFloat32(i*4,(i-32)/32,true);else view.setFloat64(i*8,(i-32)/32,true);}
      const path=join(root,`${raw}.raw`);writeFileSync(path,data);
      for(const [target]of formats){
        const args=['-cpuflags','0','-f',raw,'-ar','8000','-ac','2'],expected=execFileSync(native,['-v','error',...args,'-i',path,'-f',target,'-']);
        const output=`/${raw}-${target}.out`,result=await ffmpeg.exec([...args,'-i',`/${raw}.raw`,'-f',target,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
      }
      if(raw==='alaw'||raw==='mulaw')for(const copy of [true,false]){
        writeFileSync(path,Uint8Array.from({length:4096},(_,i)=>i&255));
        const args=['-ss','0.001','-f',raw,'-ar','8000','-ac','2'],tail=['-ss','0.0005','-t','0.1','-frames:a','2',...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed','-c:a',`pcm_${raw}`]),'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...args,'-i',path,...tail,'-']),output=`/${raw}-${copy}.crc`,result=await ffmpeg.exec([...args,'-i',`/${raw}.raw`,...tail,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1)))).toEqual(expected);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('writes and reads G711 WAV with fact metadata and interoperable multichannel payloads',async()=>{
  const {FFmpeg}=await import('@edge-ffmpeg/core');const {createMediaBackend}=await import('@edge-ffmpeg/avformat');const {createNodeFileSystem}=await import('@edge-ffmpeg/runtime-node');const {openWav}=await import('@edge-ffmpeg/containers');
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-g711-wav-'));
  try{
    const native=resolve('.build/reference/ffmpeg'),filesystem=await createNodeFileSystem({root,maxReadBytes:256,maxWriteBytes:256}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
    for(const channels of [1,2,3])for(const format of ['alaw','mulaw']){
      const data=new Uint8Array(channels*31*2),view=new DataView(data.buffer);for(let i=0;i<channels*31;i++)view.setInt16(i*2,(i*313)%65536-32768,true);
      const input=join(root,'input.raw');writeFileSync(input,data);const declarations=['-f','s16le','-ar','8000','-ac',String(channels)],output=`/${channels}-${format}.wav`;
      const result=await ffmpeg.exec([...declarations,'-i','/input.raw','-c:a',`pcm_${format}`,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
      const actual=await openWav(await filesystem.openRead(output),{maxReadBytes:256});expect(actual.info).toMatchObject({codec:`pcm_${format}`,channels,sampleRate:8000,durationSamples:31n,bitsPerSample:8});
      const expected=execFileSync(native,['-v','error',...declarations,'-i',input,'-f',format,'-']),chunks=[];for await(const packet of actual.packets())chunks.push(packet.data);expect(Buffer.concat(chunks)).toEqual(expected);
      const nativeDecoded=execFileSync(native,['-v','error','-i',join(root,output.slice(1)),'-f','s16le','-']);
      const decoded=`/${channels}-${format}.decoded`,done=await ffmpeg.exec(['-i',output,'-f','s16le',decoded]);expect(done.exitCode,JSON.stringify(done.diagnostics)).toBe(0);expect(readFileSync(join(root,decoded.slice(1)))).toEqual(nativeDecoded);
      const copy=`/${channels}-${format}.copy`,copied=await ffmpeg.exec(['-i',output,'-c:a','copy','-f',format,copy]);expect(copied.exitCode).toBe(0);expect(readFileSync(join(root,copy.slice(1)))).toEqual(expected);
      const nativeWave=`/${channels}-${format}.native.wav`;execFileSync(native,['-v','error',...declarations,'-i',input,'-c:a',`pcm_${format}`,join(root,nativeWave.slice(1))]);
      const parsed=await openWav(await filesystem.openRead(nativeWave),{maxReadBytes:256});expect(parsed.info.codec).toBe(`pcm_${format}`);
      const nativeOutput=`/${channels}-${format}.native-decoded`,nativeResult=await ffmpeg.exec(['-i',nativeWave,'-f','s16le',nativeOutput]);expect(nativeResult.exitCode,JSON.stringify(nativeResult.diagnostics)).toBe(0);expect(readFileSync(join(root,nativeOutput.slice(1)))).toEqual(nativeDecoded);
      const bytes=readFileSync(join(root,output.slice(1))),fact=bytes.indexOf('fact');expect(fact).toBeGreaterThan(0);expect(bytes.readUInt32LE(fact+8)).toBe(31);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);
