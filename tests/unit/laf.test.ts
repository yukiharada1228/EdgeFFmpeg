import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import {laf,lafChannelMask,openLaf,probeLaf} from '../../packages/containers/src/laf.js';
import {memoryInput} from '../helpers/wav.js';
/** Independent of the module: LIMITLESS HEAD quality mode st_count(rl32) vertical(f32) horizontal(f32) lfe rate(rl32) duration(rl64), then per block a bitmask byte and rate*bpp bytes. */
function file({quality=1,mode=0,streams=1,vertical=0,horizontal=0,lfe=0,rate=5,blocks=2,tail=0,mask=1}:{quality?:number;mode?:number;streams?:number;vertical?:number;horizontal?:number;lfe?:number;rate?:number;blocks?:number;tail?:number;mask?:number}={}):Uint8Array{
  const bpp=[1,2,4,3][quality]??1,block=1+rate*bpp,bytes=new Uint8Array(40+block*blocks+tail),view=new DataView(bytes.buffer);
  bytes.set([...'LIMITLESSHEAD'].map(char=>char.charCodeAt(0)));bytes[13]=quality;bytes[14]=mode;view.setUint32(15,streams,true);view.setFloat32(19,vertical,true);view.setFloat32(23,horizontal,true);bytes[27]=lfe;view.setUint32(28,rate,true);view.setBigUint64(32,123456789n,true);
  for(let i=40;i<bytes.length;i++)bytes[i]=(i*37+11)&0xff;
  for(let start=40;start<bytes.length;start+=block)bytes[start]=mask;
  return bytes;
}
async function collect(input:Awaited<ReturnType<typeof openLaf>>,start?:bigint,max?:number){const out:MediaPacket[]=[];for await(const packet of input.packets(start,max))out.push(packet);return out;}
const payload=(bytes:Uint8Array,rate:number,bpp:number,blocks:number)=>Array.from({length:blocks},(_,block)=>[...bytes.subarray(40+block*(1+rate*bpp)+1,40+(block+1)*(1+rate*bpp))]).flat();
it('maps quality to codec and the stream position to a single-channel mask as laf_read_header does',async()=>{
  for(const [quality,codec,bpp] of [[0,'pcm_u8',1],[1,'pcm_s16le',2],[2,'pcm_f32le',4],[3,'pcm_s24le',3]] as const){
    const opened=await openLaf(memoryInput(file({quality,rate:7,blocks:3})),{maxReadBytes:64});
    expect(opened.info).toMatchObject({container:'laf',codec,channels:1,sampleRate:7,channelMask:null,bitsPerSample:bpp*8,blockAlign:bpp,dataOffset:40n,dataBytes:BigInt(21*bpp),durationSamples:21n,quality,blocks:3n,blockBytes:BigInt(1+7*bpp),droppedBytes:0n});
    expect(laf.demux.packetSpan(opened.info)).toBe(7n);
  }
  // Float == compares: -0.0 equals 0, NaN and near misses fall through to mono; any nonzero lfe byte wins.
  expect([[0,0,0],[-0,-0,0],[0,-30,0],[-0,30,0],[0,-110,0],[0,110,0],[0,0,1],[5,-30,255],[0,12.5,0],[1,30,0],[Number.NaN,0,0],[0,Number.NaN,0],[0,Math.fround(-30.000002),0],[0,Number.POSITIVE_INFINITY,0]].map(([v,h,l])=>lafChannelMask(v!,h!,l!)))
    .toEqual([4,4,1,2,0x200,0x400,8,8,4,4,4,4,4,4]);
  for(const [shape,mask] of [[{horizontal:-30},1],[{horizontal:30},2],[{vertical:-0,horizontal:-110},0x200],[{horizontal:110},0x400],[{lfe:3},8],[{vertical:-0,horizontal:-0},null],[{horizontal:7},null]] as const){
    const opened=await openLaf(memoryInput(file(shape)),{maxReadBytes:64});expect(opened.info.channelMask,JSON.stringify(shape)).toBe(mask);
  }
  // mode 0 and 1 are both accepted; the header duration is ignored.
  expect((await openLaf(memoryInput(file({mode:1})),{maxReadBytes:64})).info).toMatchObject({mode:1,durationSamples:10n});
});
it('reads the header in bounded reads, checks one bitmask byte per block and drops a truncated final block',async()=>{
  const bytes=file({quality:3,rate:5,blocks:3,tail:7}),requests:Array<{offset:bigint;length:number}>=[];
  const input=await openLaf(memoryInput(bytes,requests),{maxReadBytes:3});
  expect(input.info).toMatchObject({blocks:3n,blockBytes:16n,droppedBytes:7n,durationSamples:15n,dataBytes:45n});
  expect(requests.every(request=>request.length<=3)).toBe(true);
  // Opening reads the 40 header bytes and only the bitmask byte of each block (including the dropped tail), never the samples.
  const read=[...new Set(requests.flatMap(request=>Array.from({length:request.length},(_,i)=>Number(request.offset)+i)))].sort((a,b)=>a-b);
  expect(read).toEqual([...Array.from({length:40},(_,i)=>i),40,56,72,88]);
  requests.length=0;const packets=await collect(input,7n,6);
  expect(packets.map(packet=>[packet.pts,packet.duration,packet.data.length])).toEqual([[7n,2n,6],[9n,1n,3],[10n,2n,6],[12n,2n,6],[14n,1n,3]]);
  expect(packets[0]!.timeBase).toEqual({num:1n,den:5n});expect(packets.every(packet=>packet.dts===packet.pts&&packet.flags===1&&packet.streamIndex===0)).toBe(true);
  // Each packet skips its block's bitmask byte: samples 7.. start at 40 + 16 + 1 + 2*3.
  expect(requests[0]!.offset).toBe(63n);expect(requests.every(request=>request.length<=3&&![40n,56n,72n,88n].includes(request.offset))).toBe(true);
  expect([...packets.flatMap(packet=>[...packet.data])]).toEqual(payload(bytes,5,3,3).slice(21));
  const all=await collect(input,0n,4096);expect(all.map(packet=>[packet.pts,packet.data.length])).toEqual([[0n,15],[5n,15],[10n,15]]);
  expect(all.flatMap(packet=>[...packet.data])).toEqual(payload(bytes,5,3,3));
  expect(await collect(input,15n,3)).toEqual([]);expect((await collect(input,14n,3)).map(packet=>packet.pts)).toEqual([14n]);
  await expect(collect(input,16n)).rejects.toThrow('seek');await expect(collect(input,-1n)).rejects.toThrow('seek');await expect(collect(input,0n,2)).rejects.toThrow('budget');await expect(collect(input,0n,1.5)).rejects.toThrow('budget');
  // A lone bitmask byte, a partial block and a header-only file.
  for(const [tail,blocks] of [[1,2],[15,2],[0,0],[14,0]] as const){const opened=await openLaf(memoryInput(file({quality:3,rate:5,blocks,tail})),{maxReadBytes:64});expect([opened.info.blocks,opened.info.droppedBytes,opened.info.durationSamples],`${tail}/${blocks}`).toEqual([BigInt(blocks),BigInt(tail),BigInt(blocks*5)]);}
  expect(await collect(await openLaf(memoryInput(file({blocks:0})),{maxReadBytes:64}))).toEqual([]);
  // Only bit 0 of the bitmask matters for one stream.
  expect((await openLaf(memoryInput(file({mask:0xff})),{maxReadBytes:64})).info.blocks).toBe(2n);
});
it('refuses malformed headers with native INVALIDDATA, multi-stream files, zero bitmasks and bad budgets',async()=>{
  const open=(bytes:Uint8Array,maxReadBytes=64)=>openLaf(memoryInput(bytes),{maxReadBytes});
  const refusal=async(bytes:Uint8Array,message:string,exitCode?:number)=>{const error=await open(bytes).then(()=>null,(caught:unknown)=>caught);expect(error,message).toBeInstanceOf(Error);expect((error as Error).message).toBe(message);if(exitCode!==undefined)expect((error as {exitCode?:number}).exitCode,message).toBe(exitCode);return error as Error;};
  await refusal(file({quality:4}),'Invalid LAF quality: 4',183);await refusal(file({quality:255}),'Invalid LAF quality: 255',183);
  await refusal(file({mode:2}),'Invalid LAF mode: 2',183);await refusal(file({streams:0}),'Invalid LAF stream count: 0',183);await refusal(file({streams:4097}),'Invalid LAF stream count: 4097',183);
  const multi=await refusal(file({streams:2}),'LAF files with 2 streams are not implemented');expect((multi as {code?:string}).code).toBe('unsupported-command');await refusal(file({streams:4096}),'LAF files with 4096 streams are not implemented');
  await refusal(file({rate:0}),'Invalid LAF sample rate: 0',183);
  // bpp * rate must stay below INT32_MAX: 536870911 f32le samples is the largest block, 2147483647 u8 samples is refused.
  expect((await open(file({quality:2,rate:536870911,blocks:0}))).info.sampleRate).toBe(536870911);await refusal(file({quality:2,rate:536870912,blocks:0}),'Invalid LAF sample rate: 536870912',183);
  expect((await open(file({quality:0,rate:2147483646,blocks:0}))).info.sampleRate).toBe(2147483646);await refusal(file({quality:0,rate:2147483647,blocks:0}),'Invalid LAF sample rate: 2147483647',183);
  await refusal(file({quality:2,rate:0xffffffff,blocks:0}),'Invalid LAF sample rate: 4294967295',183);
  // read_header skips the "LIMITLESS" bytes and checks only "HEAD"; truncated headers read zeros and fail avio_feof.
  const head=file();head[12]=0x45;await refusal(head,'Invalid LAF header',183);
  const limitless=file();limitless[0]=0;expect((await open(limitless)).info.blocks).toBe(2n);
  await refusal(file({blocks:0}).subarray(0,39),'Truncated LAF header',183);await refusal(file({blocks:0}).subarray(0,10),'Invalid LAF header',183);await refusal(new Uint8Array(0),'Invalid LAF header',183);
  expect((await open(file({blocks:0}))).info.durationSamples).toBe(0n);
  for(const [shape,offset] of [[{mask:0},40],[{mask:2},40],[{blocks:3,mask:0xfe},40]] as const)await refusal(file(shape),`Invalid LAF stored bitmask at ${offset}`);
  const mid=file({rate:5,blocks:3});mid[40+11]=4;await refusal(mid,'Invalid LAF stored bitmask at 51');
  const tail=file({rate:5,blocks:2,tail:4});tail[40+22]=0;await refusal(tail,'Invalid LAF stored bitmask at 62');
  await expect(open(file(),0)).rejects.toThrow('budget');await expect(probeLaf(memoryInput(file()),0)).rejects.toThrow('budget');
  const good=file(),short:ReadHandle={size:BigInt(good.length),async readAt(){return new Uint8Array(0);}};
  await expect(openLaf(short,{maxReadBytes:64})).rejects.toThrow('read length');
  const long:ReadHandle={size:BigInt(good.length),async readAt(_offset,length){return new Uint8Array(length+1);}};
  await expect(openLaf(long,{maxReadBytes:64})).rejects.toThrow('read length');
});
it('checks the abort signal around every read and packet',async()=>{
  const bytes=file({rate:5,blocks:3}),controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(openLaf(memoryInput(bytes),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stopped');
  const live=new AbortController();let reads=0;
  const input:ReadHandle={size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===4)live.abort(new Error('mid-read'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openLaf(input,{maxReadBytes:8,signal:live.signal})).rejects.toThrow('mid-read');
  const later=new AbortController(),opened=await openLaf(memoryInput(bytes),{maxReadBytes:64,signal:later.signal}),iterator=opened.packets(0n,4)[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);later.abort(new Error('packets'));await expect(iterator.next()).rejects.toThrow('packets');
});
it('probes exactly the 13 bytes laf_probe compares and registers a demux-only descriptor',async()=>{
  const bytes=file(),requests:Array<{offset:bigint;length:number}>=[];
  expect(await detectAudioContainer(memoryInput(bytes,requests),3)).toBe('laf');expect(requests.every(request=>request.length<=3&&request.offset+BigInt(request.length)<=13n)).toBe(true);
  expect(await probeLaf(memoryInput(bytes),1)).toBe(true);expect(await probeLaf(memoryInput(bytes.subarray(0,13)),64)).toBe(true);expect(await probeLaf(memoryInput(bytes.subarray(0,12)),64)).toBe(false);
  for(const index of [0,3,4,8,9,12]){const changed=bytes.slice();changed[index]=0x20;expect(laf.demux.probe.head(changed.subarray(0,4)),String(index)).toBe(index>3);if(index>3)expect(await probeLaf(memoryInput(changed),64)).toBe(false);await expect(detectAudioContainer(memoryInput(changed),64)).rejects.toThrow('signature');}
  expect(containerFormat('laf')).toBe(laf);expect(containerProbes).toContain(laf);
  expect(laf).toMatchObject({name:'laf',demux:{probe:{precedence:100},headerBytes:128}});expect('mux' in laf).toBe(false);expect('extensions' in laf.demux).toBe(false);expect(Object.isFrozen(laf.demux)&&Object.isFrozen(laf.demux.probe)).toBe(true);
});
it('demuxes through the PCM backend with small packet budgets and refuses laf output, seeks and bad inputs before any output opens',async()=>{
  const files=new Map<string,Uint8Array>();let opens=0;
  const filesystem={
    async openRead(path:string):Promise<ReadHandle>{const bytes=files.get(path);if(!bytes)throw new Error(`missing ${path}`);return memoryInput(bytes);},
    async openWrite(path:string):Promise<WriteHandle>{opens++;const chunks:Uint8Array[]=[];return {async write(chunk){chunks.push(chunk.slice());},async commit(){files.set(path,Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));},async abort(){}};},
    async exists(path:string){return files.has(path);},async stat(path:string){const bytes=files.get(path);return bytes?{size:BigInt(bytes.length)}:null;}
  };
  const ffmpeg=new FFmpeg({filesystem:filesystem as never,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:64,maxPendingPackets:2,maxCpuTimeMs:1000}});
  const input=file({quality:1,rate:50,blocks:3,tail:20});files.set('/in.laf',input);
  const copy=await ffmpeg.exec(['-i','/in.laf','-c:a','copy','-f','s16le','/out.raw']);expect(copy.exitCode,JSON.stringify(copy.diagnostics)).toBe(0);
  expect([...files.get('/out.raw')!]).toEqual(payload(input,50,2,3));
  const crc=await ffmpeg.exec(['-i','/in.laf','-c:a','copy','-f','framecrc','/out.crc']);expect(crc.exitCode,JSON.stringify(crc.diagnostics)).toBe(0);
  expect(new TextDecoder().decode(files.get('/out.crc')).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,5).map(field=>Number(field)))).toEqual([[0,0,50,100],[50,50,50,100],[100,100,50,100]]);
  // Output -ss with copy keeps whole packets from the first one at or after the start, as native does (compared in the differential test).
  const cut=await ffmpeg.exec(['-i','/in.laf','-ss','0.5','-t','1.4','-c:a','copy','-f','framecrc','/cut.crc']);expect(cut.exitCode,JSON.stringify(cut.diagnostics)).toBe(0);
  expect(new TextDecoder().decode(files.get('/cut.crc')).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,4).map(field=>Number(field)))).toEqual([[25,25,50]]);
  opens=0;
  for(const [name,bytes,message] of [['/q4.laf',file({quality:4}),'Invalid LAF quality: 4'],['/multi.laf',file({streams:2}),'LAF files with 2 streams are not implemented'],['/mask.laf',file({mask:0}),'Invalid LAF stored bitmask at 40'],['/cut.laf',file().subarray(0,30),'Truncated LAF header']] as const){
    files.set(name,bytes);const result=await ffmpeg.exec(['-f','laf','-i',name,'-f','s16le','/bad.raw']);expect(result.exitCode,name).not.toBe(0);expect(result.diagnostics.at(-1)?.message,name).toBe(message);
  }
  const seek=await ffmpeg.exec(['-ss','0.1','-i','/in.laf','-f','s16le','/seek.raw']);expect([seek.diagnostics.at(-1)?.code,seek.diagnostics.at(-1)?.message]).toEqual(['unsupported-command','LAF input seeking is not implemented']);
  const muxed=await ffmpeg.exec(['-i','/in.laf','-f','laf','/out.laf']);expect(muxed.exitCode).not.toBe(0);expect(muxed.diagnostics.at(-1)?.message).toMatch(/Output requires/);
  expect(opens).toBe(0);
});
