import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {openW64} from '@edge-ffmpeg/containers';
const native=resolve('.build/reference/ffmpeg');
const codecs=['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le','pcm_alaw','pcm_mulaw'] as const;
const widths:Record<string,number>={pcm_u8:1,pcm_s16le:2,pcm_s24le:3,pcm_s32le:4,pcm_f32le:4,pcm_f64le:8,pcm_alaw:1,pcm_mulaw:1};
const rawFormat=(codec:string)=>codec==='pcm_u8'?'u8':codec==='pcm_alaw'?'alaw':codec==='pcm_mulaw'?'mulaw':codec.slice(4);
const budget={maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000};
/** Native writes to a seekable file: w64/WAV trailers rewrite sizes and the fact count only when seekable. */
function nativeFile(args:readonly string[],path:string):Buffer{execFileSync(native,['-v','error','-y',...args,path],{timeout:30000});return readFileSync(path);}
function checkReference(){
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string},metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string};expect(metadata.commit).toBe(lock.commit);
  expect(execFileSync(native,['-v','error','-muxers'],{encoding:'utf8'})).toMatch(/E\s+w64\s/);expect(execFileSync(native,['-v','error','-demuxers'],{encoding:'utf8'})).toMatch(/D\s+w64\s/);
}
it('matches native W64 mux bytes and native-written W64 demux for eight codecs rates channel counts and odd lengths',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-w64-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    let muxed=0,demuxed=0,partial=0;
    for(const channels of [1,2,3])for(const rate of [8000,96000])for(const samples of [1,3,8,67]){
      const input=new Uint8Array(samples*channels*2),view=new DataView(input.buffer);for(let i=0;i<samples*channels;i++)view.setInt16(i*2,(i*3137+rate)%65536-32768,true);writeFileSync(join(root,'input.raw'),input);
      for(const codec of codecs){
        const name=`${codec}-${rate}-${channels}-${samples}`,args=['-f','s16le','-ar',String(rate),'-ac',String(channels),'-i'],tail=['-c:a',codec,'-bitexact','-f','w64'],nativePath=join(root,`${name}-native.w64`);
        execFileSync(native,['-v','error',...args,join(root,'input.raw'),...tail,nativePath]);
        const result=await ffmpeg.exec([...args,'/input.raw',...tail,`/${name}.w64`]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);
        expect(readFileSync(join(root,`${name}.w64`)).equals(readFileSync(nativePath)),name).toBe(true);muxed++;
        // Native's data size covers its 8-byte alignment padding, so its demuxer returns the padding as samples.
        const blockAlign=channels*widths[codec]!,padded=Math.ceil(samples*blockAlign/8)*8;
        if(padded%blockAlign){
          await expect(openW64(await filesystem.openRead(`/${name}-native.w64`),{maxReadBytes:128}),name).rejects.toThrow('partial sample frame');
          const refused=await ffmpeg.exec(['-i',`/${name}-native.w64`,'-c:a','copy','-bitexact','-f','framecrc',`/${name}.refused.crc`]);expect(refused.exitCode).not.toBe(0);expect(refused.diagnostics.at(-1)?.message).toMatch(/partial sample frame/);partial++;continue;
        }
        const opened=await openW64(await filesystem.openRead(`/${name}-native.w64`),{maxReadBytes:128});
        expect(opened.info,name).toMatchObject({container:'w64',codec,channels,sampleRate:rate,blockAlign,durationSamples:BigInt(padded/blockAlign),dataOffset:BigInt(readFileSync(nativePath).length-padded),factSamples:['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le'].includes(codec)?null:BigInt(samples)});
        const chunks:Uint8Array[]=[];for await(const packet of opened.packets())chunks.push(packet.data);
        expect(Buffer.concat(chunks).equals(execFileSync(native,['-v','error','-i',nativePath,'-c:a','copy','-f',rawFormat(codec),'-'])),name).toBe(true);
        for(const [suffix,before,after] of [['copy.crc',[],['-c:a','copy','-bitexact','-f','framecrc']],['decode.raw',['-cpuflags','0'],['-f','s16le']],['copy.w64',[],['-c:a','copy','-f','w64']]] as const){
          const expected=nativeFile([...before,'-i',nativePath,...after],join(root,`${name}.native.${suffix}`)),out=`/${name}.${suffix}`,run=await ffmpeg.exec([...before,'-i',`/${name}-native.w64`,...after,out]);
          expect(run.exitCode,JSON.stringify(run.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${name}/${suffix}`).toBe(true);
        }
        demuxed++;
      }
    }
    expect([muxed,demuxed,partial]).toEqual([192,146,46]);
  }finally{rmSync(root,{recursive:true,force:true});}
},300000);
it('matches W64 native packet timing for copy seek duration frame limits filters and WAV conversion',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-w64-timing-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget});
    const source=new Uint8Array(4300*4),view=new DataView(source.buffer);for(let i=0;i<8600;i++)view.setInt16(i*2,(i*3137)%65536-32768,true);writeFileSync(join(root,'input.raw'),source);
    let compared=0;
    for(const codec of codecs){
      const path=join(root,`${codec}.w64`);execFileSync(native,['-v','error','-f','s16le','-ar','8000','-ac','2','-i',join(root,'input.raw'),'-c:a',codec,'-bitexact',path]);
      const profiles=[{before:[],after:[]},{before:['-ss','0.000125'],after:['-ss','0.001','-t','0.02']},{before:[],after:['-frames:a','2']},{before:['-ss','0.25'],after:['-t','0.1']}];
      for(const [index,profile]of profiles.entries())for(const copy of [true,false])for(const [format,extra] of [['framecrc',['-bitexact']],['w64',[]],['wav',['-bitexact']]] as const){
        const before=['-cpuflags','0',...profile.before],after=[...profile.after,...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1,asetrate=11025','-c:a','pcm_s16le']),...extra,'-f',format];
        const out=`/${codec}-${index}-${copy}.${format}`,expected=nativeFile([...before,'-i',path,...after],join(root,'native'+out.slice(1))),result=await ffmpeg.exec([...before,'-i',`/${codec}.w64`,...after,out]);
        expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${codec}/${index}/${copy}/${format}`).toBe(true);compared++;
      }
      // Seeks at or beyond EOF keep the WAV path's explicit refusal.
      for(const seek of ['0.5375','1']){const refused=await ffmpeg.exec(['-ss',seek,'-i',`/${codec}.w64`,'-c:a','copy','-f','w64',`/${codec}-${seek}.w64`]);expect(refused.exitCode).not.toBe(0);expect(refused.diagnostics.at(-1)?.code).toBe('unsupported-seek');}
    }
    expect(compared).toBe(192);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);
it('selects W64 by extension and declaration converts from WAV and refuses unsupported W64 requests explicitly',async()=>{
  checkReference();const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-w64-route-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:64,maxWriteBytes:64}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{...budget,maxBufferBytes:64}});
    const input=new Uint8Array(203*2*2),view=new DataView(input.buffer);for(let i=0;i<406;i++)view.setInt16(i*2,(i*7919)%65536-32768,true);writeFileSync(join(root,'input.raw'),input);writeFileSync(join(root,'empty.raw'),new Uint8Array(0));
    execFileSync(native,['-v','error','-f','s16le','-ar','44100','-ac','2','-i',join(root,'input.raw'),join(root,'input.wav')]);
    const same=async(argv:readonly string[],nativeArgs:readonly string[],output:string)=>{
      const nativePath=join(root,'native-'+output.slice(1));execFileSync(native,['-v','error','-y',...nativeArgs,nativePath]);
      const result=await ffmpeg.exec([...argv,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(readFileSync(nativePath)),output).toBe(true);
    };
    // Default pcm_s16le, no -bitexact: w64 carries no software metadata, so plain output is byte-exact.
    await same(['-i','/input.wav'],['-i',join(root,'input.wav')],'/extension.w64');
    await same(['-i','/input.wav','-c:a','pcm_f32le','-fflags','+bitexact','-f','w64'],['-i',join(root,'input.wav'),'-c:a','pcm_f32le','-fflags','+bitexact','-f','w64'],'/declared.out');
    await same(['-f','w64','-i','/extension.w64','-c:a','pcm_s24le'],['-f','w64','-i',join(root,'extension.w64'),'-c:a','pcm_s24le'],'/from-w64.wav');
    await same(['-f','s16le','-i','/empty.raw','-c:a','pcm_alaw','-f','w64'],['-f','s16le','-i',join(root,'empty.raw'),'-c:a','pcm_alaw','-f','w64'],'/empty.w64');
    await same(['-f','s16le','-i','/input.raw','-c:a','pcm_mulaw','-frames:a','0','-f','w64'],['-f','s16le','-i',join(root,'input.raw'),'-c:a','pcm_mulaw','-frames:a','0','-f','w64'],'/frames0.w64');
    // Native cannot reopen its own empty w64 (data size 24); neither can EdgeFFmpeg.
    expect(spawnSync(native,['-v','error','-i',join(root,'native-empty.w64'),'-f','s16le','-'],{timeout:15000}).status).not.toBe(0);
    for(const [argv,code,message] of [
      [['-i','/native-empty.w64','-f','s16le','/empty-decoded.raw'],'execution-failed',/chunk size/],
      [['-f','w64','-i','/input.wav','-f','s16le','/declared.raw'],'execution-failed',/riff GUID/],
      [['-f','s16le','-i','/input.raw','-c:a','pcm_s16be','-f','w64','/big-endian.w64'],'unsupported-command',/W64 muxer does not support pcm_s16be/]
    ] as const){
      const nativeArgs=argv.map(value=>value.startsWith('/')?join(root,value.slice(1)):value);expect(spawnSync(native,['-v','error','-y',...nativeArgs],{timeout:15000}).status,argv.join(' ')).not.toBe(0);
      const result=await ffmpeg.exec(argv);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.code).toBe(code);expect(result.diagnostics.at(-1)?.message).toMatch(message);expect(result.outputs).toEqual([]);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
