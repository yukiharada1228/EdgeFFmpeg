import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import {openSds,probeSds,sds,sdsSamplePeriod,sdsSampleRate,sdsSampleWidth,unpackSdsBlock} from '../../packages/containers/src/sds.js';
import {memoryInput} from '../helpers/wav.js';
/** Independent of the module: F0 7E ch 01 nn nn depth period(3 bytes LE 7-bit) length loop... F7, then F0 7E ch 02 nn + 120 bytes + checksum + F7 per packet. */
function dump(depth:number,period:number,payloads:readonly Uint8Array[],tweak?:(bytes:Uint8Array)=>void):Uint8Array{
  const bytes=new Uint8Array(21+127*payloads.length);bytes.set([0xf0,0x7e,0x00,0x01,0x00,0x00,depth,period&0x7f,(period>>7)&0x7f,(period>>14)&0x7f]);bytes[20]=0xf7;
  payloads.forEach((payload,index)=>{const base=21+127*index;bytes.set([0xf0,0x7e,0x00,0x02,index&0x7f],base);bytes.set(payload,base+5);bytes[base+125]=0x55;bytes[base+126]=0xf7;});
  tweak?.(bytes);return bytes;
}
const payload=(seed:number,mask=0x7f)=>Uint8Array.from({length:120},(_,i)=>(i*37+seed*101+13)&mask);
async function collect(input:Awaited<ReturnType<typeof openSds>>,start?:bigint,max?:number){const out:MediaPacket[]=[];for await(const packet of input.packets(start,max))out.push(packet);return out;}
const words=(data:Uint8Array)=>Array.from({length:data.length/4},(_,i)=>new DataView(data.buffer,data.byteOffset).getUint32(i*4,true));
 it('unpacks byte2, byte3 and byte4 packets into left-justified 32-bit words as native does',()=>{
  const src=payload(1);
  const ref2=Array.from({length:60},(_,i)=>(((src[2*i]!*2**25)+(src[2*i+1]!*2**18))%2**32));
  const ref3=Array.from({length:40},(_,i)=>(src[3*i]!*2**25+src[3*i+1]!*2**18+src[3*i+2]!*2**11)%2**32);
  const ref4=Array.from({length:30},(_,i)=>(src[4*i]!*2**25+src[4*i+1]!*2**18+src[4*i+2]!*2**11+src[4*i+3]!*2**4)%2**32);
  expect(words(unpackSdsBlock(src,2))).toEqual(ref2);expect(words(unpackSdsBlock(src,3))).toEqual(ref3);expect(words(unpackSdsBlock(src,4))).toEqual(ref4);
  // 8-bit bytes: byte2_read adds (carry into bit 25), byte3/4_read OR; bits above 31 are dropped.
  const high=new Uint8Array(120).fill(0xff);
  expect(words(unpackSdsBlock(high,2))[0]).toBe(((0xff*2**25)+(0xff*2**18))%2**32);
  expect(words(unpackSdsBlock(high,3))[0]).toBe(((0xff<<25)|(0xff<<18)|(0xff<<11))>>>0);
  expect(words(unpackSdsBlock(high,4))[0]).toBe(((0xff<<25)|(0xff<<18)|(0xff<<11)|(0xff<<4))>>>0);
  expect(()=>unpackSdsBlock(new Uint8Array(119),2)).toThrow('packet length');
 });
 it('maps bit depths to widths and sample periods to integer rates',()=>{
  expect([8,13,14,20,21,28].map(sdsSampleWidth)).toEqual([2,2,3,3,4,4]);for(const depth of [7,29,0,255,8.5])expect(()=>sdsSampleWidth(depth)).toThrow('bit depth');
  expect([0,1,3,7,22675,20833,0x1fffff].map(sdsSampleRate)).toEqual([16000,1000000000,333333333,142857142,44101,48000,476]);
  expect(sdsSamplePeriod(Uint8Array.from([0x7f,0x7f,0x7f]))).toBe(0x1fffff);expect(sdsSamplePeriod(Uint8Array.from([0xff,0x80,0x81]))).toBe(0x7f|(1<<14));
 });
 it('parses the header and checks every packet with bounded reads before returning samples',async()=>{
  const bytes=dump(16,22675,[payload(1),payload(2),payload(3)]),requests:Array<{offset:bigint;length:number}>=[];
  const input=await openSds(memoryInput(bytes,requests),{maxReadBytes:2});
  expect(input.info).toMatchObject({container:'sds',codec:'pcm_u32le',channels:1,sampleRate:44101,channelMask:null,blockAlign:4,bitsPerSample:32,dataOffset:21n,dataBytes:381n,durationSamples:120n,bitDepth:16,samplePeriod:22675,packetSamples:40,blocks:3n});
  expect(requests.every(request=>request.length<=2)).toBe(true);
  // Only the F0 7E and F7 framing bytes are read while opening, never the payload.
  const read=new Set(requests.flatMap(request=>Array.from({length:request.length},(_,i)=>Number(request.offset)+i)));
  for(let block=0;block<3;block++)for(let i=7;i<125;i++)expect(read.has(21+127*block+i)).toBe(false);
  requests.length=0;const packets=await collect(input,45n,32);
  expect(packets.map(packet=>[packet.pts,packet.duration,packet.data.length])).toEqual([[45n,8n,32],[53n,8n,32],[61n,8n,32],[69n,8n,32],[77n,3n,12],[80n,8n,32],[88n,8n,32],[96n,8n,32],[104n,8n,32],[112n,8n,32]]);
  expect(packets[0]!.timeBase).toEqual({num:1n,den:44101n});expect(requests.every(request=>request.length<=2&&request.offset>=21n+127n)).toBe(true);
  const all=await collect(input,0n,4096);expect(all.map(packet=>packet.data.length)).toEqual([160,160,160]);
  expect(words(all[1]!.data)).toEqual(words(unpackSdsBlock(payload(2),3)));expect(await collect(input,120n,4)).toEqual([]);
  await expect(collect(input,121n)).rejects.toThrow('seek');await expect(collect(input,0n,3)).rejects.toThrow('budget');await expect(collect(input)).rejects.toThrow('budget');expect((await collect(input,118n,4)).map(packet=>packet.data.length)).toEqual([4,4]);
  const wide=await openSds(memoryInput(bytes),{maxReadBytes:4096});expect((await collect(wide,0n,4096)).map(packet=>packet.duration)).toEqual([40n,40n,40n]);
  for(const [depth,span] of [[8,60],[13,60],[14,40],[20,40],[21,30],[28,30]] as const){const opened=await openSds(memoryInput(dump(depth,0,[payload(depth)])),{maxReadBytes:64});expect([opened.info.packetSamples,opened.info.sampleRate,opened.info.durationSamples,sds.demux.packetSpan(opened.info)]).toEqual([span,16000,BigInt(span),BigInt(span)]);}
  expect((await openSds(memoryInput(dump(8,0,[])),{maxReadBytes:64})).info.durationSamples).toBe(0n);
 });
 it('follows read_header in ignoring the magic and closing F7 when declared',async()=>{
  const odd=dump(12,100,[payload(5)],bytes=>{bytes[0]=0;bytes[3]=9;bytes[20]=0;});
  expect((await openSds(memoryInput(odd),{maxReadBytes:64})).info).toMatchObject({sampleRate:10000000,packetSamples:60});
  expect(await probeSds(memoryInput(odd),64)).toBe(false);
 });
 it('refuses bad depths, framing and truncation up front',async()=>{
  const open=(bytes:Uint8Array,maxReadBytes=64)=>openSds(memoryInput(bytes),{maxReadBytes});
  await expect(open(dump(16,0,[]).subarray(0,20))).rejects.toThrow('Truncated SDS header');
  for(const depth of [7,29])await expect(open(dump(depth,0,[payload(1)]))).rejects.toThrow(`Invalid SDS bit depth: ${depth}`);
  const good=dump(16,0,[payload(1),payload(2)]);
  await expect(open(good.subarray(0,good.length-1))).rejects.toThrow('Truncated SDS data packet');
  await expect(open(Uint8Array.from([...good,0xf0]))).rejects.toThrow('Truncated SDS data packet');
  for(const index of [21,22,148,149])await expect(open(dump(16,0,[payload(1),payload(2)],bytes=>{bytes[index]=0;}),3)).rejects.toThrow(/Invalid SDS data packet header at (21|148)$/);
  for(const index of [147,274])await expect(open(dump(16,0,[payload(1),payload(2)],bytes=>{bytes[index]=0xf6;}))).rejects.toThrow('Missing SDS data packet end');
  // Native skips the channel, packet type, packet number and checksum bytes.
  await expect(open(dump(16,0,[payload(1)],bytes=>{bytes[23]=0x33;bytes[24]=0x7f;bytes[25]=0x11;bytes[146]=0;}))).resolves.toBeDefined();
  await expect(open(good,0)).rejects.toThrow('budget');await expect(probeSds(memoryInput(good),0)).rejects.toThrow('budget');
  const short:ReadHandle={size:BigInt(good.length),async readAt(){return new Uint8Array(0);}};
  await expect(openSds(short,{maxReadBytes:64})).rejects.toThrow('read length');
 });
 it('checks the abort signal around every read',async()=>{
  const bytes=dump(20,0,[payload(1),payload(2)]),controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(openSds(memoryInput(bytes),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stopped');
  const live=new AbortController();let reads=0;
  const input:ReadHandle={size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===3)live.abort(new Error('mid-read'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openSds(input,{maxReadBytes:8,signal:live.signal})).rejects.toThrow('mid-read');
  const later=new AbortController(),opened=await openSds(memoryInput(bytes),{maxReadBytes:64,signal:later.signal}),iterator=opened.packets()[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);later.abort(new Error('packets'));await expect(iterator.next()).rejects.toThrow('packets');
 });
 it('probes exactly the 21 bytes sds_probe reads and registers a demux-only descriptor',async()=>{
  const bytes=dump(8,0,[payload(1)]),requests:Array<{offset:bigint;length:number}>=[];
  expect(await detectAudioContainer(memoryInput(bytes,requests),3)).toBe('sds');expect(requests.every(request=>request.length<=3&&request.offset+BigInt(request.length)<=21n)).toBe(true);
  expect(await probeSds(memoryInput(bytes),1)).toBe(true);expect(await probeSds(memoryInput(bytes.subarray(0,20)),64)).toBe(false);
  for(const [index,value] of [[6,7],[6,29],[20,0xf6],[3,2],[1,0x7f]] as const){const changed=bytes.slice();changed[index]=value;if(index===3||index===1)expect(sds.demux.probe.head(changed)).toBe(false);else{expect(sds.demux.probe.head(changed)).toBe(true);expect(await probeSds(memoryInput(changed),64)).toBe(false);}await expect(detectAudioContainer(memoryInput(changed),64)).rejects.toThrow('signature');}
  expect(containerFormat('sds')).toBe(sds);expect(containerProbes).toContain(sds);
  expect(sds).toMatchObject({name:'sds',demux:{probe:{precedence:100},headerBytes:128}});expect('mux' in sds).toBe(false);expect('extensions' in sds.demux).toBe(false);expect(Object.isFrozen(sds.demux)&&Object.isFrozen(sds.demux.probe)).toBe(true);
 });
 it('demuxes through the PCM backend and refuses sds output and bad inputs before any output opens',async()=>{
  const files=new Map<string,Uint8Array>();let opens=0;
  const filesystem={
    async openRead(path:string):Promise<ReadHandle>{const bytes=files.get(path);if(!bytes)throw new Error(`missing ${path}`);return memoryInput(bytes);},
    async openWrite(path:string):Promise<WriteHandle>{opens++;const chunks:Uint8Array[]=[];return {async write(chunk){chunks.push(chunk.slice());},async commit(){files.set(path,Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));},async abort(){}};},
    async exists(path:string){return files.has(path);},async stat(path:string){const bytes=files.get(path);return bytes?{size:BigInt(bytes.length)}:null;}
  };
  const ffmpeg=new FFmpeg({filesystem:filesystem as never,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
  files.set('/in.sds',dump(8,0,[payload(1),payload(2)]));
  const copy=await ffmpeg.exec(['-i','/in.sds','-c:a','copy','-f','u32le','/out.raw']);expect(copy.exitCode,JSON.stringify(copy.diagnostics)).toBe(0);
  expect([...files.get('/out.raw')!]).toEqual([...unpackSdsBlock(payload(1),2),...unpackSdsBlock(payload(2),2)]);
  const crc=await ffmpeg.exec(['-i','/in.sds','-c:a','copy','-f','framecrc','/out.crc']);expect(crc.exitCode,JSON.stringify(crc.diagnostics)).toBe(0);
  expect(new TextDecoder().decode(files.get('/out.crc')).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,4).map(field=>Number(field)))).toEqual([[0,0,60],[60,60,60]]);
  opens=0;
  for(const [name,bytes,message] of [['/depth.sds',dump(29,0,[payload(1)]),'Invalid SDS bit depth: 29'],['/end.sds',dump(8,0,[payload(1)],b=>{b[147]=0;}),'Missing SDS data packet end at 21'],['/cut.sds',dump(8,0,[payload(1)]).subarray(0,100),'Truncated SDS data packet']] as const){
   files.set(name,bytes);const result=await ffmpeg.exec(['-f','sds','-i',name,'-f','s16le','/bad.raw']);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toBe(message);
  }
  const seek=await ffmpeg.exec(['-ss','0.001','-i','/in.sds','-f','s16le','/seek.raw']);expect([seek.diagnostics.at(-1)?.code,seek.diagnostics.at(-1)?.message]).toEqual(['unsupported-command','SDS input seeking is not implemented']);
  const muxed=await ffmpeg.exec(['-i','/in.sds','-f','sds','/out.sds']);expect(muxed.exitCode).not.toBe(0);expect(muxed.diagnostics.at(-1)?.message).toMatch(/Output requires/);
  expect(opens).toBe(0);
 });
