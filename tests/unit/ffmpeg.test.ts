import { expect, it } from 'vitest';
import { FFmpeg } from '@edge-ffmpeg/core';
import { createWavBackend } from '@edge-ffmpeg/avformat';
import type { VirtualFileSystem } from '@edge-ffmpeg/core';
const unavailable: VirtualFileSystem = { async openRead() { throw new Error('unexpected read'); }, async openWrite() { throw new Error('unexpected write'); } };
it('reports missing backends, invalid syntax and cancellation without throwing', async () => {
  const ffmpeg = new FFmpeg({ filesystem: unavailable });
  expect((await ffmpeg.exec(['-i', '/a.wav', '-c', 'copy', '/b.wav'])).diagnostics[0]?.code).toBe('unimplemented');
  expect((await ffmpeg.exec(['-bad'])).diagnostics[0]?.code).toBe('invalid-arguments');
  const abort = new AbortController(); abort.abort('stop');
  expect((await ffmpeg.exec([], { signal: abort.signal })).diagnostics[0]?.code).toBe('cancelled');
});
it('rejects unsupported WAV syntax before opening any input or output', async () => {
  let reads = 0, writes = 0;
  const filesystem: VirtualFileSystem = { async openRead() { reads++; throw new Error('read'); }, async openWrite() { writes++; throw new Error('write'); } };
  const ffmpeg = new FFmpeg({ filesystem, backend: createWavBackend() });
  for (const argv of [
    ['-f', 'wav', '-i', '/a.wav', '-c', 'copy', '-vf', 'scale=1:1', '/b.wav'],
    ['-f', 'wav', '-i', '/a.wav', '-c', 'copy', '-map', '0:v', '/b.wav'],
    ['-ss', '-1', '-f', 'wav', '-i', '/a.wav', '-c', 'copy', '/b.wav'],
    ['-f', 'wav', '-i', '/a.wav', '-c', 'copy', '//a.wav'],
    ['-f', 'wav', '-i', '/a.wav', '-i', '/b.wav', '-c', 'copy', '/c.wav'],
    ['-loglevel', 'quiet', '-f', 'wav', '-i', '/a.wav', '-c', 'copy', '/b.wav']
  ]) {
    const result = await ffmpeg.exec(argv); expect(result.exitCode).toBe(1); expect(result.diagnostics[0]?.code).toBe('unsupported-command');
  }
  expect(reads).toBe(0); expect(writes).toBe(0);
});

it('rejects unsupported filters and filtering with copy before opening files', async () => {
  let reads=0,writes=0;
  const filesystem:VirtualFileSystem={async openRead(){reads++;throw new Error('unexpected read');},async openWrite(){writes++;throw new Error('unexpected write');}};
  const ffmpeg=new FFmpeg({filesystem,backend:createWavBackend()});
  for(const [filter,codec] of [['volume=foo','pcm_s16le'],['volume=65536:precision=fixed','pcm_s16le'],['anull','copy']]){
    const result=await ffmpeg.exec(['-f','wav','-i','/a.wav','-af',filter!,'-c:a',codec!,'/b.wav']);expect(result.exitCode).toBe(1);
  }
  expect(reads).toBe(0);expect(writes).toBe(0);
});

import { collectingOutput } from '../helpers/output.js';
it('rejects invalid frame limits and unsupported frame selectors before file access',async()=>{
  let reads=0,writes=0;
  const filesystem:VirtualFileSystem={async openRead(){reads++;throw new Error('unexpected read');},async openWrite(){writes++;throw new Error('unexpected write');}};
  const ffmpeg=new FFmpeg({filesystem,backend:createWavBackend()});
  for(const value of ['1.5','1e3','9223372036854775808','-9223372036854775809'])expect((await ffmpeg.exec(['-f','wav','-i','/a.wav','-frames:a',value,'/b.wav'])).diagnostics[0]?.code).toBe('invalid-arguments');
  for(const args of [['-frames:a','1','-f','wav','-i','/a.wav','/b.wav'],['-f','wav','-i','/a.wav','-frames:a:1','1','/b.wav']])expect((await ffmpeg.exec(args)).diagnostics[0]?.code).toBe('unsupported-command');
  expect(reads).toBe(0);expect(writes).toBe(0);
});
it('commits zero-frame raw output without reading any PCM data from a large declared input',async()=>{
  const sink=collectingOutput();let requests=0;
  const filesystem:VirtualFileSystem={async openRead(){return {size:1n<<60n,async readAt(){requests++;throw new Error('unexpected data read');}};},async openWrite(){return sink.output;}};
  const ffmpeg=new FFmpeg({filesystem,backend:createWavBackend()});
  const result=await ffmpeg.exec(['-f','s16le','-ar','8000','-ac','1','-i','/a.raw','-frames:a','0','-f','s16le','/b.raw']);
  expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(requests).toBe(0);expect(sink.committed).toBe(true);expect(sink.bytes()).toHaveLength(0);
});
it('preflights reframe allocation and aborts staged output on a later source failure',async()=>{
  for(const oversized of [true,false]){
    const sink=collectingOutput();let writes=0,reads=0;
    const filesystem:VirtualFileSystem={async openRead(){return {size:10n,async readAt(offset,length){reads++;return offset===0n?new Uint8Array(length).fill(128):new Uint8Array();}};},async openWrite(){writes++;return sink.output;}};
    const ffmpeg=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:1024,maxBufferBytes:8,maxCpuTimeMs:1000,maxPendingPackets:2}});
    const result=await ffmpeg.exec(['-f','u8','-ar','8000','-ac','1','-i','/a.raw','-af',`asetnsamples=${oversized?9:3}`,'-f','s16le','/b.raw']);expect(result.exitCode).toBe(1);expect(sink.committed).toBe(false);
    if(oversized){expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(writes).toBe(0);expect(reads).toBe(0);}
    else{expect(writes).toBe(1);expect(sink.aborted).toBe(true);expect(sink.bytes()).toHaveLength(0);}
  }
});
it('shrinks physical PCM reads under aggregate memory pressure and rejects combined FIFOs before output',async()=>{
  for(const reframe of [false,true]){
    const sink=collectingOutput(),requests:number[]=[];let writes=0;
    const filesystem:VirtualFileSystem={async openRead(){return {size:100n,async readAt(_offset,length){requests.push(length);return new Uint8Array(length).fill(128);}};},async openWrite(){writes++;return sink.output;}};
    const ffmpeg=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:reframe?256:128,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const result=await ffmpeg.exec(['-f','u8','-ar','8000','-ac','1','-i','/a.raw',...(reframe?['-af','asetnsamples=16,asetnsamples=16']:[]),'-f','s16le','/b.raw']);
    if(reframe){expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(writes).toBe(0);expect(requests).toHaveLength(0);}
    else{expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(Math.max(...requests)).toBe(9);expect(sink.bytes()).toEqual(new Uint8Array(200));expect(sink.committed).toBe(true);}
  }
});
it('rejects non-WAV PCM representations before reading samples or creating output',async()=>{
  let dataReads=0,writes=0;
  const filesystem:VirtualFileSystem={async openRead(){return {size:4n,async readAt(){dataReads++;return new Uint8Array(4);}};},async openWrite(){writes++;throw new Error('unexpected output');}};
  const ffmpeg=new FFmpeg({filesystem,backend:createWavBackend()});
  for(const codec of ['pcm_s8','pcm_s16be','pcm_u16le','pcm_u24be','pcm_f64be']){
    const result=await ffmpeg.exec(['-f','s16le','-ar','8000','-ac','1','-i','/in.raw','-c:a',codec,'/out.wav']);expect(result.diagnostics[0]?.code).toBe('unsupported-command');
  }
  expect(dataReads).toBe(0);expect(writes).toBe(0);
});
it('rejects unsupported or oversized AIFF output before data access or output creation',async()=>{
  let reads=0,writes=0;
  const filesystem:VirtualFileSystem={async openRead(){return {size:1n<<34n,async readAt(){reads++;throw new Error('unexpected sample read');}};},async openWrite(){writes++;throw new Error('unexpected output');}};
  const ffmpeg=new FFmpeg({filesystem,backend:createWavBackend()});
  for(const codec of ['pcm_s32le','pcm_s16be']){
    const result=await ffmpeg.exec(['-f','s16le','-ar','8000','-ac','1','-i','/input.raw','-c:a',codec,'-f','aiff','/output.bin']);expect(result.exitCode).toBe(1);
  }
  expect(reads).toBe(0);expect(writes).toBe(0);
});
it('preflights unsupported remix profiles layouts copy and multichannel requests',async()=>{
  for(const args of [
    ['-f','s16le','-ar','8000','-ac','1','-i','/a.raw','-ac','2','-c:a','copy','-f','s16le','/b.raw'],
    ['-guess_layout_max','0','-f','s16le','-ar','8000','-ac','1','-i','/a.raw','-ac','2','-f','s16le','/b.raw'],
    ['-f','s16le','-ar','8000','-ac','1','-i','/a.raw','-ac','3','-f','s16le','/b.raw'],
    ['-f','s16le','-ar','8000','-ac','1','-i','/a.raw','-ac','2','-f','f32le','/b.raw']
  ]){
    let reads=0,writes=0;const filesystem:VirtualFileSystem={async openRead(){return {size:8n,async readAt(){reads++;return new Uint8Array(8);}};},async openWrite(){writes++;throw new Error('unexpected output');}};
    const result=await new FFmpeg({filesystem,backend:createWavBackend()}).exec(args);expect(result.diagnostics[0]?.code).toBe('unsupported-command');expect(reads).toBe(0);expect(writes).toBe(0);
  }
});
it('preflights rate conversion format scheduling and combined state budgets before sample reads or output',async()=>{
  const cases=[
    {source:'f64le',after:['-af','apad=pad_len=10','-f','f64le'],code:'resource-budget'},
    {source:'f64le',after:['-f','f64le'],flags:[],code:'unsupported-command'},
    {source:'f64le',after:['-f','f64le'],resident:1024,code:'resource-budget'}
  ];
  for(const item of cases){let reads=0,writes=0;const filesystem:VirtualFileSystem={async openRead(){return {size:512n,async readAt(){reads++;throw new Error('unexpected samples');}};},async openWrite(){writes++;throw new Error('unexpected output');}};
    const frontend=new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:item.resident??1024*1024,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
    const result=await frontend.exec([...(item.flags??['-cpuflags','0']),'-f',item.source,'-ar','8000','-ac','1','-i','/in.raw','-ar','16000',...item.after,'/out.raw']);expect(result.diagnostics[0]?.code,JSON.stringify(item)).toBe(item.code);expect(reads).toBe(0);expect(writes).toBe(0);
  }
});
it('shrinks resampler payload frames when FIR state consumes most of the resident budget',async()=>{
  const data=new Uint8Array(512);new DataView(data.buffer).setFloat64(0,1,true);let maxRead=0,maxWrite=0,written=0,committed=false;
  const filesystem:VirtualFileSystem={async openRead(){return {size:512n,async readAt(offset,length){maxRead=Math.max(maxRead,length);return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return {async write(chunk){maxWrite=Math.max(maxWrite,chunk.length);written+=chunk.length;},async commit(){committed=true;},async abort(){throw new Error('unexpected abort');}};}};
  const result=await new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:1240,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}}).exec(['-cpuflags','0','-f','f64le','-ar','8000','-ac','1','-i','/in.raw','-ar','16000','-f','f64le','/out.raw']);
  expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(committed).toBe(true);expect(written).toBe(1024);expect(maxRead).toBeGreaterThan(0);expect(maxRead).toBeLessThanOrEqual(16);expect(maxWrite).toBeLessThanOrEqual(16);
});
it('reserves signed16 FIR expansion when both raw endpoints are unsigned8',async()=>{
  const data=Uint8Array.from({length:64},(_,i)=>(i*37+13)&255);let maxRead=0,maxWrite=0,written=0,committed=false;
  const filesystem:VirtualFileSystem={async openRead(){return {size:64n,async readAt(offset,length){maxRead=Math.max(maxRead,length);return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return {async write(chunk){maxWrite=Math.max(maxWrite,chunk.length);written+=chunk.length;},async commit(){committed=true;},async abort(){throw new Error('unexpected abort');}};}};
  const result=await new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:400,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}}).exec(['-cpuflags','0','-f','u8','-ar','8000','-ac','1','-i','/in.raw','-ar','16000','-f','u8','/out.raw']);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(committed).toBe(true);expect(written).toBe(128);expect(maxRead).toBeGreaterThan(0);expect(maxRead).toBeLessThanOrEqual(6);expect(maxWrite).toBeLessThanOrEqual(6);
});
it('allows minimum-length padding with no unnecessary default silence-packet reservation',async()=>{
  const data=new Uint8Array(26);let bytes=0,committed=false;const filesystem:VirtualFileSystem={async openRead(){return {size:26n,async readAt(offset,length){return data.slice(Number(offset),Number(offset)+length);}};},async openWrite(){return {async write(chunk){bytes+=chunk.length;},async commit(){committed=true;},async abort(){throw new Error('unexpected abort');}};}};
  for(const [minimum,expected]of [['3',26],['15',30]] as const){bytes=0;committed=false;const result=await new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:1024,maxBufferBytes:8,maxPendingPackets:2,maxCpuTimeMs:1000}}).exec(['-f','s16le','-ar','8000','-ac','1','-i','/in.raw','-af',`apad=whole_len=${minimum}`,'-f','s16le','/out.raw']);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(bytes).toBe(expected);expect(committed).toBe(true);}
});
it('rejects aggregate generated silence buffers before output creation on a configured empty source',async()=>{
  let writes=0,reads=0;const filesystem:VirtualFileSystem={async openRead(){return {size:0n,async readAt(){reads++;return new Uint8Array();}};},async openWrite(){writes++;throw new Error('unexpected output');}};
  const result=await new FFmpeg({filesystem,backend:createWavBackend(),budget:{maxResidentBytes:60,maxBufferBytes:32,maxPendingPackets:2,maxCpuTimeMs:1000}}).exec(['-f','u8','-ar','8000','-ac','1','-i','/input.raw','-af','apad=pad_len=7:packet_size=7','-f','u8','/output.raw']);expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(reads).toBe(0);expect(writes).toBe(0);
});

it('probes newly supported MP4 output requests without opening outputs after input read failure',async()=>{let reads=0,writes=0;const ffmpeg=new FFmpeg({backend:createWavBackend(),filesystem:{async openRead(){reads++;throw new Error('Input unavailable');},async openWrite(){writes++;throw new Error('Unexpected output');}}});const result=await ffmpeg.exec(['-i','/a.wav','-c','copy','/b.mp4']);expect(result.exitCode).toBe(1);expect(result.diagnostics[0]?.code).toBe('execution-failed');expect(result.diagnostics[0]?.message).toBe('Input unavailable');expect([reads,writes]).toEqual([1,0]);});

it('does not replace an input failure with a later WAV overwrite conflict',async()=>{
 let reads=0,writes=0;const filesystem:VirtualFileSystem={async openRead(){reads++;throw new Error('input unavailable');},async openWrite(){writes++;throw new Error('unexpected output');}};const result=await new FFmpeg({filesystem,backend:createWavBackend()}).exec(['-y','-n','-i','/a.wav','-c','copy','/b.wav']);expect(result.exitCode).toBe(1);expect(result.diagnostics).toEqual([{code:'execution-failed',message:'input unavailable'}]);expect(reads).toBe(1);expect(writes).toBe(0);
});
