import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import {openRsd,probeRsd,rsd,rsdHead} from '../../packages/containers/src/rsd.js';
import {memoryInput} from '../helpers/wav.js';
/** Independent of the module: "RSD" + version, tag, RL32 channels, bit depth, rate, unknown, data start; payload bytes from `start` to EOF. */
function dump(version:string,tag:string,channels:number,rate:number,start:number,payload:number,startField=start):Uint8Array{
  const bytes=new Uint8Array(Math.max(28,start+payload)),view=new DataView(bytes.buffer);
  for(let i=0;i<bytes.length;i++)bytes[i]=(i*37+11)&255;
  bytes.set([...'RSD'+version].map(c=>c.charCodeAt(0)),0);bytes.set([...tag].map(c=>c.charCodeAt(0)),4);
  view.setUint32(8,channels>>>0,true);view.setUint32(12,16,true);view.setUint32(16,rate>>>0,true);view.setUint32(20,0,true);view.setInt32(24,startField,true);
  return bytes.subarray(0,start+payload>=28?start+payload:bytes.length);
}
async function collect(input:Awaited<ReturnType<typeof openRsd>>,start?:bigint,max?:number){const out:MediaPacket[]=[];for await(const packet of input.packets(start,max))out.push(packet);return out;}
const open=(bytes:Uint8Array,maxReadBytes=64)=>openRsd(memoryInput(bytes),{maxReadBytes});
it('parses versions, tags and data starts with bounded header reads',async()=>{
  const requests:Array<{offset:bigint;length:number}>=[];
  const input=await openRsd(memoryInput(dump('3','PCMB',2,22050,40,2048),requests),{maxReadBytes:4});
  expect(input.info).toMatchObject({container:'rsd',codec:'pcm_s16be',channels:2,sampleRate:22050,channelMask:null,blockAlign:4,bitsPerSample:16,dataOffset:40n,dataBytes:2048n,durationSamples:512n,version:3,tag:'PCMB',start:40,packetSamples:256});
  expect('copyRefusal' in input.info).toBe(false);expect(Object.isFrozen(input.info)).toBe(true);
  // Only the 28 header bytes are read while opening, never the payload.
  expect(requests.every(request=>request.length<=4&&request.offset+BigInt(request.length)<=28n)).toBe(true);
  const packets=await collect(input,100n,4);expect(packets[0]).toMatchObject({pts:100n,duration:1n});expect(packets[0]!.data).toEqual(dump('3','PCMB',2,22050,40,2048).slice(440,444));expect(requests.every(request=>request.length<=4)).toBe(true);
  for(const version of ['2','5','6'])expect((await open(dump(version,'PCM ',1,8000,32,1024))).info).toMatchObject({codec:'pcm_s16le',version:Number(version),dataOffset:32n,durationSamples:512n});
  // Version 4 starts at 0x800 and ignores the RL32 at 24.
  const v4=await open(dump('4','PCM ',4,48000,0x800,4096,7));expect(v4.info).toMatchObject({dataOffset:0x800n,start:0x800,durationSamples:512n,packetSamples:128});
  // The start is absolute, so it may lie inside the header (avio_skip seeks backwards).
  const inside=dump('2','PCM ',1,8000,0,1024);expect((await open(inside)).info).toMatchObject({dataOffset:0n,durationSamples:512n});
  expect((await collect(await open(inside,4096),0n,4096))[0]!.data).toEqual(inside);
  expect((await open(dump('3','PCM ',2,8000,12,1024))).info.dataOffset).toBe(12n);
  // A start at EOF is an empty stream, as native writes no packets.
  expect((await open(dump('3','PCM ',2,8000,64,0))).info.durationSamples).toBe(0n);
});
it('takes packet spans of 512/channels and marks short final packets for copy refusal',async()=>{
  for(const [channels,span] of [[1,512],[2,256],[4,128],[8,64],[16,32],[512,1]] as const){const opened=await open(dump('3','PCM ',channels,8000,32,1024*channels),1024);expect([opened.info.packetSamples,rsd.demux.packetSpan(opened.info)]).toEqual([span,BigInt(span)]);}
  const short=await open(dump('3','PCM ',2,8000,32,2500));
  expect(short.info).toMatchObject({durationSamples:625n,copyRefusal:'RSD stream copy of a short final packet is not implemented'});
  expect((await open(dump('3','PCM ',2,8000,32,2048))).info.copyRefusal).toBeUndefined();
});
it('refuses tags, channels, rates, starts and trailing bytes as native does or explicitly',async()=>{
  const refusal=async(bytes:Uint8Array,message:string|RegExp,exitCode?:number)=>{const error=await open(bytes).catch((caught:unknown)=>caught) as Error&{exitCode?:number};expect(error).toBeInstanceOf(Error);expect(error.message).toMatch(message);if(exitCode!==undefined)expect(error.exitCode).toBe(exitCode);};
  await refusal(dump('3','OGG ',2,8000,32,1024),'RSD codec tag OGG is not implemented',176);
  await refusal(dump('3','ABCD',2,8000,32,1024),'Unknown RSD codec tag: "ABCD"',183);
  await refusal(dump('3','PCM\0',2,8000,32,1024),/Unknown RSD codec tag/,183);
  for(const tag of ['VAG ','GADP','WADP','RADP','XADP','XMA '])await refusal(dump('3',tag,2,8000,32,1024),`RSD codec tag ${JSON.stringify(tag)} is not implemented`);
  for(const channels of [0,-1,59652324])await refusal(dump('3','PCM ',channels,8000,32,1024),`Invalid RSD number of channels: ${channels}`,183);
  for(const channels of [3,5,6,7,1024,59652323])await refusal(dump('3','PCM ',channels,8000,32,1024),`RSD ${channels}-channel packets that split sample frames are not implemented`);
  await refusal(dump('3','PCM ',2,0,32,1024),'Invalid RSD sample rate: 0',183);
  await refusal(dump('3','PCM ',2,-8000,32,1024),'RSD sample rate -8000 is not implemented');
  await refusal(dump('3','PCM ',2,8000,-4,1024,-4).subarray(0,1052),'Invalid RSD data start: -4',183);
  await refusal(dump('3','PCM ',2,8000,32,1024).subarray(0,1050),'RSD partial trailing sample frame is not implemented');
  const beyond=dump('3','PCM ',2,8000,32,1024);new DataView(beyond.buffer).setInt32(24,2000,true);await refusal(beyond,'RSD data start beyond the end of the input is not implemented');
  await refusal(dump('4','PCM ',2,8000,64,1024),'RSD data start beyond the end of the input is not implemented');
  await refusal(dump('3','PCM ',2,8000,32,1024).subarray(0,23),'Truncated RSD header');
  await refusal(dump('3','PCM ',2,8000,32,1024).subarray(0,27),'Truncated RSD header');
  // Version 4 needs no RL32 start field.
  const v4=dump('4','PCM ',1,8000,0x800,0).subarray(0,24);await refusal(v4,'RSD data start beyond the end of the input is not implemented');
  await expect(open(dump('3','PCM ',2,8000,32,1024),0)).rejects.toThrow('budget');await expect(probeRsd(memoryInput(dump('3','PCM ',2,8000,32,1024)),0)).rejects.toThrow('budget');
  const short:ReadHandle={size:1056n,async readAt(){return new Uint8Array(0);}};await expect(openRsd(short,{maxReadBytes:64})).rejects.toThrow('read length');
});
it('checks the abort signal around every read',async()=>{
  const bytes=dump('3','PCM ',2,8000,32,4096),controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(openRsd(memoryInput(bytes),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stopped');
  const live=new AbortController();let reads=0;
  const input:ReadHandle={size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===3)live.abort(new Error('mid-read'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openRsd(input,{maxReadBytes:4,signal:live.signal})).rejects.toThrow('mid-read');
  const later=new AbortController(),opened=await openRsd(memoryInput(bytes),{maxReadBytes:64,signal:later.signal}),iterator=opened.packets()[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);later.abort(new Error('packets'));await expect(iterator.next()).rejects.toThrow('packets');
});
it('probes exactly the 20 bytes rsd_probe reads, only at its score-100 case, and registers a demux-only descriptor',async()=>{
  const bytes=dump('3','PCM ',2,22050,32,1024),requests:Array<{offset:bigint;length:number}>=[];
  expect(await detectAudioContainer(memoryInput(bytes,requests),3)).toBe('rsd');expect(requests.every(request=>request.length<=3&&request.offset+BigInt(request.length)<=20n)).toBe(true);
  for(const version of '23456')expect(rsdHead(dump(version,'PCM ',2,8000,32,0))).toBe(true);
  for(const version of '017:')expect(rsdHead(dump(version,'PCM ',2,8000,32,0))).toBe(false);
  expect(rsdHead(Uint8Array.from([0x52,0x53,0x45,0x33]))).toBe(false);expect(rsdHead(Uint8Array.from([0x52,0x53,0x44]))).toBe(false);
  for(const [channels,rate,score100] of [[1,1,true],[256,384000,true],[0,8000,false],[257,8000,false],[3,8000,true],[2,0,false],[2,384001,false]] as const){
    const probed=dump('3','PCM ',channels,rate,32,0);expect(await probeRsd(memoryInput(probed),64),`${channels}/${rate}`).toBe(score100);
    if(!score100)await expect(detectAudioContainer(memoryInput(probed),64)).rejects.toThrow('signature');
  }
  expect(await probeRsd(memoryInput(bytes.subarray(0,19)),64)).toBe(false);expect(await probeRsd(memoryInput(bytes.subarray(0,20)),1)).toBe(true);
  expect(containerFormat('rsd')).toBe(rsd);expect(containerProbes).toContain(rsd);
  expect(rsd).toMatchObject({name:'rsd',demux:{probe:{precedence:100},headerBytes:28}});expect('mux' in rsd).toBe(false);expect('extensions' in rsd.demux).toBe(false);expect(Object.isFrozen(rsd.demux)&&Object.isFrozen(rsd.demux.probe)).toBe(true);
});
it('demuxes through the PCM backend and refuses copy of a short tail, input seeks and rsd output before any output opens',async()=>{
  const files=new Map<string,Uint8Array>();let opens=0;
  const filesystem={
    async openRead(path:string):Promise<ReadHandle>{const bytes=files.get(path);if(!bytes)throw new Error(`missing ${path}`);return memoryInput(bytes);},
    async openWrite(path:string):Promise<WriteHandle>{opens++;const chunks:Uint8Array[]=[];return {async write(chunk){chunks.push(chunk.slice());},async commit(){files.set(path,Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));},async abort(){}};},
    async exists(path:string){return files.has(path);},async stat(path:string){const bytes=files.get(path);return bytes?{size:BigInt(bytes.length)}:null;}
  };
  const ffmpeg=new FFmpeg({filesystem:filesystem as never,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
  const whole=dump('3','PCMB',2,8000,32,2048);files.set('/in.rsd',whole);
  const copy=await ffmpeg.exec(['-i','/in.rsd','-c:a','copy','-f','s16be','/out.raw']);expect(copy.exitCode,JSON.stringify(copy.diagnostics)).toBe(0);expect(files.get('/out.raw')).toEqual(whole.slice(32));
  const crc=await ffmpeg.exec(['-i','/in.rsd','-c:a','copy','-f','framecrc','/out.crc']);expect(crc.exitCode,JSON.stringify(crc.diagnostics)).toBe(0);
  expect(new TextDecoder().decode(files.get('/out.crc')).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,5).map(field=>Number(field)))).toEqual([[0,0,256,1024],[256,256,256,1024]]);
  files.set('/short.rsd',dump('3','PCM ',2,8000,32,2500));
  const decoded=await ffmpeg.exec(['-i','/short.rsd','-f','s16le','/short.raw']);expect(decoded.exitCode,JSON.stringify(decoded.diagnostics)).toBe(0);expect(files.get('/short.raw')).toEqual(dump('3','PCM ',2,8000,32,2500).slice(32));
  opens=0;
  const refused=await ffmpeg.exec(['-i','/short.rsd','-c:a','copy','-f','framecrc','/short.crc']);expect([refused.exitCode,refused.diagnostics.at(-1)?.code,refused.diagnostics.at(-1)?.message]).toEqual([1,'unsupported-command','RSD stream copy of a short final packet is not implemented']);
  for(const [name,bytes,message] of [['/ogg.rsd',dump('3','OGG ',2,8000,32,1024),'RSD codec tag OGG is not implemented'],['/three.rsd',dump('3','PCM ',3,8000,32,1536),'RSD 3-channel packets that split sample frames are not implemented'],['/tail.rsd',dump('3','PCM ',2,8000,32,1022),'RSD partial trailing sample frame is not implemented']] as const){
   files.set(name,bytes);const result=await ffmpeg.exec(['-i',name,'-f','s16le','/bad.raw']);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toBe(message);
  }
  const seek=await ffmpeg.exec(['-ss','0.001','-i','/in.rsd','-f','s16le','/seek.raw']);expect([seek.diagnostics.at(-1)?.code,seek.diagnostics.at(-1)?.message]).toEqual(['unsupported-command','RSD input seeking is not implemented']);
  const muxed=await ffmpeg.exec(['-i','/in.rsd','-f','rsd','/out.rsd']);expect(muxed.exitCode).not.toBe(0);expect(muxed.diagnostics.at(-1)?.message).toMatch(/Output requires/);
  expect(opens).toBe(0);
});
