import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import {msf,msfPacketSamples,openMsf,probeMsf,readMsfHeader} from '../../packages/containers/src/msf.js';
import {memoryInput} from '../helpers/wav.js';
/** Independent of the module: "MSF" + version byte, RB32 codec, channels, size and rate, padding to 0x40, then the payload. */
function msfFile(codec:number,channels:number,rate:number,payload:Uint8Array,size=payload.length,version=0x43):Uint8Array{
  const bytes=new Uint8Array(64+payload.length),view=new DataView(bytes.buffer);bytes.set([0x4d,0x53,0x46,version]);
  view.setUint32(4,codec);view.setUint32(8,channels>>>0);view.setUint32(12,size>>>0);view.setUint32(16,rate>>>0);view.setUint32(20,0xffffffff);bytes.fill(0xaa,24,64);bytes.set(payload,64);
  return bytes;
}
const payload=(length:number,seed=1)=>Uint8Array.from({length},(_,i)=>(i*37+seed*101+(i>>5))&255);
async function collect(input:{packets(start?:bigint,max?:number):AsyncIterable<MediaPacket>},start?:bigint,max?:number){const out:MediaPacket[]=[];for await(const packet of input.packets(start,max))out.push(packet);return out;}
it('parses the header with bounded reads and never reads the payload while opening',async()=>{
  const data=payload(2*1024*2),bytes=msfFile(0,2,44100,data,12345),requests:Array<{offset:bigint;length:number}>=[];
  const input=await openMsf(memoryInput(bytes,requests),{maxReadBytes:4});
  expect(input.info).toMatchObject({container:'msf',codec:'pcm_s16be',channels:2,sampleRate:44100,channelMask:null,blockAlign:4,bitsPerSample:16,dataOffset:64n,dataBytes:4096n,durationSamples:1024n,codecId:0,sizeField:12345});
  expect('copyRefusal' in input.info).toBe(false);
  expect(requests.every(request=>request.length<=4&&request.offset+BigInt(request.length)<=20n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(20);
  requests.length=0;const packets=await collect(input,0n,4);
  expect(requests.every(request=>request.offset>=64n)).toBe(true);expect(Uint8Array.from(packets.flatMap(packet=>[...packet.data]))).toEqual(data);
  expect(packets[0]!.timeBase).toEqual({num:1n,den:44100n});
  const le=await openMsf(memoryInput(msfFile(1,3,32000,payload(6*7))),{maxReadBytes:64});
  expect(le.info).toMatchObject({codec:'pcm_s16le',channels:3,sampleRate:32000,blockAlign:6,durationSamples:7n,codecId:1,copyRefusal:'MSF stream copy of a short final packet is not implemented'});
  // The size field only sets native's duration: the data still runs to EOF.
  for(const size of [0,1,0xffffffff])expect((await openMsf(memoryInput(msfFile(0,1,8000,payload(2048),size)),{maxReadBytes:64})).info.durationSamples).toBe(1024n);
  expect((await openMsf(memoryInput(msfFile(0,1,8000,new Uint8Array(0))),{maxReadBytes:64})).info).toMatchObject({durationSamples:0n});
  expect('copyRefusal' in (await openMsf(memoryInput(msfFile(0,1,8000,new Uint8Array(0))),{maxReadBytes:64})).info).toBe(false);
  expect(msf.demux.packetSpan()).toBe(512n);expect(msfPacketSamples).toBe(512);
});
it('marks copy refusal exactly when the payload is not a whole number of 1024*channels-byte packets',async()=>{
  for(const channels of [1,2,3,6])for(const frames of [0,1,511,512,513,1024,1535]){
    const opened=await openMsf(memoryInput(msfFile(channels%2,channels,48000,payload(frames*2*channels,channels))),{maxReadBytes:4096});
    expect(opened.info.copyRefusal,`${channels}/${frames}`).toBe(frames%512?'MSF stream copy of a short final packet is not implemented':undefined);
  }
});
it('refuses header values in native order with native statuses, and partial frames, short files and input seeks',async()=>{
  const open=(bytes:Uint8Array,seek?:bigint)=>openMsf(memoryInput(bytes),{maxReadBytes:64,...(seek===undefined?{}:{seek})});
  const refusal=async(bytes:Uint8Array,message:string,code:string,exitCode?:number)=>{const error=await open(bytes).then(()=>null,(caught:unknown)=>caught as {message:string;code:string;exitCode?:number});expect(error?.message).toBe(message);expect(error?.code).toBe(code);if(exitCode!==undefined)expect(error?.exitCode).toBe(exitCode);};
  // Channels (183) are checked before the rate (183), and both before the codec.
  for(const channels of [0,-1,2097151,0x7fffffff])await refusal(msfFile(3,channels,0,payload(64)),`Invalid MSF channel count: ${channels>>>0}`,'unsupported-command',183);
  await expect(open(msfFile(0,2097150,8000,new Uint8Array(0)))).rejects.toThrow('MSF inputs with 2097150 channels are not implemented');
  await expect(open(msfFile(0,65536,8000,new Uint8Array(0)))).rejects.toThrow('MSF inputs with 65536 channels are not implemented');
  for(const rate of [0,-1,0x80000000])await refusal(msfFile(99,1,rate,payload(64)),`Invalid MSF sample rate: ${rate>>>0}`,'unsupported-command',183);
  for(const [codec,name] of [[3,'adpcm_psx'],[4,'atrac3'],[5,'atrac3'],[6,'atrac3'],[7,'mp3']] as const)await refusal(msfFile(codec,2,44100,payload(64)),`MSF codec ${codec} (${name}) is not implemented`,'unsupported');
  for(const codec of [2,8,16,17,99,0xffffffff])await refusal(msfFile(codec,2,44100,payload(64)),`MSF codec ${codec>>>0} is not supported`,'unsupported-command',176);
  await expect(open(msfFile(0,2,8000,payload(4*5+2)))).rejects.toThrow('MSF partial sample frame is not implemented');
  await expect(open(msfFile(1,3,8000,payload(6*5+4)))).rejects.toThrow('MSF partial sample frame is not implemented');
  for(const length of [0,19,20,63])await expect(open(msfFile(0,1,8000,new Uint8Array(0)).subarray(0,length))).rejects.toThrow('MSF inputs shorter than the 64-byte header are not implemented');
  await refusal(msfFile(0,1,8000,new Uint8Array(0)).subarray(0,63),'MSF inputs shorter than the 64-byte header are not implemented','unsupported');
  await expect(open(msfFile(0,1,8000,payload(2048)),1n)).rejects.toThrow('MSF input seeking is not implemented');
  await expect(open(msfFile(0,1,8000,payload(2048)),0n)).resolves.toBeDefined();
  await expect(openMsf(memoryInput(msfFile(0,1,8000,payload(8))),{maxReadBytes:0})).rejects.toThrow('budget');
  await expect(readMsfHeader(memoryInput(msfFile(0,1,8000,payload(8))),{maxReadBytes:1.5})).rejects.toThrow('budget');
  const short:ReadHandle={size:100n,async readAt(){return new Uint8Array(0);}};
  await expect(openMsf(short,{maxReadBytes:64})).rejects.toThrow('Unexpected MSF header read length');
});
it('checks the abort signal around every header read and during packets',async()=>{
  const bytes=msfFile(0,2,8000,payload(4096)),controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(openMsf(memoryInput(bytes),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stopped');
  await expect(probeMsf(memoryInput(bytes),64,controller.signal)).rejects.toThrow('stopped');
  const live=new AbortController();let reads=0;
  const input:ReadHandle={size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===3)live.abort(new Error('mid-read'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openMsf(input,{maxReadBytes:4,signal:live.signal})).rejects.toThrow('mid-read');
  const later=new AbortController(),opened=await openMsf(memoryInput(bytes),{maxReadBytes:64,signal:later.signal}),iterator=opened.packets()[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);later.abort(new Error('packets'));await expect(iterator.next()).rejects.toThrow('packets');
});
it('probes exactly the 20 bytes msf_probe reads and registers a demux-only descriptor',async()=>{
  const bytes=msfFile(0,1,8000,payload(64)),requests:Array<{offset:bigint;length:number}>=[];
  expect(await detectAudioContainer(memoryInput(bytes,requests),3)).toBe('msf');expect(requests.every(request=>request.length<=3&&request.offset+BigInt(request.length)<=20n)).toBe(true);
  expect(await probeMsf(memoryInput(bytes),1)).toBe(true);expect(await probeMsf(memoryInput(bytes.subarray(0,19)),64)).toBe(false);expect(await probeMsf(memoryInput(bytes.subarray(0,20)),64)).toBe(true);
  // Any fourth byte and any codec pass msf_probe (codecs above 16 only lower native's score).
  for(const version of [0,0x30,0xff])expect(msf.demux.probe.head(msfFile(0,1,8000,payload(4),4,version))).toBe(true);
  expect(await probeMsf(memoryInput(msfFile(99,1,8000,payload(4))),64)).toBe(true);
  // RB32 is unsigned: only zero channels or rates fail the probe.
  expect(await probeMsf(memoryInput(msfFile(0,-1,0x80000000,payload(4))),64)).toBe(true);
  for(const [channels,rate] of [[0,8000],[1,0],[0,0]] as const){const changed=msfFile(0,channels,rate,payload(4));expect(msf.demux.probe.head(changed)).toBe(true);expect(await probeMsf(memoryInput(changed),64)).toBe(false);await expect(detectAudioContainer(memoryInput(changed),64)).rejects.toThrow('signature');}
  for(const index of [0,1,2]){const changed=bytes.slice();changed[index]=0x6d;expect(msf.demux.probe.head(changed)).toBe(false);}
  await expect(probeMsf(memoryInput(bytes),0)).rejects.toThrow('budget');
  expect(containerFormat('msf')).toBe(msf);expect(containerProbes).toContain(msf);
  expect(msf).toMatchObject({name:'msf',demux:{probe:{precedence:100},headerBytes:64}});expect('mux' in msf).toBe(false);expect('extensions' in msf.demux).toBe(false);expect('seekBeyondEnd' in msf.demux).toBe(false);
  expect(Object.isFrozen(msf.demux)&&Object.isFrozen(msf.demux.probe)).toBe(true);
});
it('demuxes through the PCM backend, refuses copy of a short tail and msf output before any output opens',async()=>{
  const files=new Map<string,Uint8Array>();let opens=0;
  const filesystem={
    async openRead(path:string):Promise<ReadHandle>{const bytes=files.get(path);if(!bytes)throw new Error(`missing ${path}`);return memoryInput(bytes);},
    async openWrite(path:string):Promise<WriteHandle>{opens++;const chunks:Uint8Array[]=[];return {async write(chunk){chunks.push(chunk.slice());},async commit(){files.set(path,Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));},async abort(){}};},
    async exists(path:string){return files.has(path);},async stat(path:string){const bytes=files.get(path);return bytes?{size:BigInt(bytes.length)}:null;}
  };
  const ffmpeg=new FFmpeg({filesystem:filesystem as never,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
  const whole=payload(1024*2*2),tail=payload(700*4);
  files.set('/in.msf',msfFile(0,2,8000,whole));files.set('/tail.msf',msfFile(1,2,8000,tail));
  const copy=await ffmpeg.exec(['-i','/in.msf','-c:a','copy','-f','s16be','/out.raw']);expect(copy.exitCode,JSON.stringify(copy.diagnostics)).toBe(0);expect(files.get('/out.raw')).toEqual(whole);
  const crc=await ffmpeg.exec(['-i','/in.msf','-c:a','copy','-f','framecrc','/out.crc']);expect(crc.exitCode,JSON.stringify(crc.diagnostics)).toBe(0);
  expect(new TextDecoder().decode(files.get('/out.crc')).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,4).map(field=>Number(field)))).toEqual([[0,0,512],[512,512,512]]);
  const decoded=await ffmpeg.exec(['-i','/tail.msf','-f','s16le','/tail.raw']);expect(decoded.exitCode,JSON.stringify(decoded.diagnostics)).toBe(0);expect(files.get('/tail.raw')).toEqual(tail);
  const rows=await ffmpeg.exec(['-i','/tail.msf','-c:a','pcm_s16le','-f','framecrc','/tail.crc']);expect(rows.exitCode).toBe(0);
  expect(new TextDecoder().decode(files.get('/tail.crc')).split('\n').filter(line=>/^0,/.test(line)).map(line=>Number(line.split(',')[3]))).toEqual([512,188]);
  opens=0;
  const refused=await ffmpeg.exec(['-i','/tail.msf','-c:a','copy','-f','framecrc','/tail-copy.crc']);
  expect([refused.exitCode,refused.diagnostics.at(-1)?.code,refused.diagnostics.at(-1)?.message]).toEqual([1,'unsupported-command','MSF stream copy of a short final packet is not implemented']);
  for(const [name,bytes,message] of [['/atrac.msf',msfFile(4,2,44100,payload(64)),'MSF codec 4 (atrac3) is not implemented'],['/odd.msf',msfFile(0,2,8000,payload(6)),'MSF partial sample frame is not implemented'],['/rate.msf',msfFile(0,2,0x80000000,payload(8)),'Invalid MSF sample rate: 2147483648']] as const){
    files.set(name,bytes);const result=await ffmpeg.exec(['-i',name,'-f','s16le','/bad.raw']);expect(result.exitCode,name).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toBe(message);
  }
  const declared=await ffmpeg.exec(['-f','msf','-i','/in.msf','-f','s16le','/declared.raw']);expect(declared.exitCode).toBe(0);
  const seek=await ffmpeg.exec(['-ss','0.001','-i','/in.msf','-f','s16le','/seek.raw']);expect([seek.diagnostics.at(-1)?.code,seek.diagnostics.at(-1)?.message]).toEqual(['unsupported-command','MSF input seeking is not implemented']);
  const muxed=await ffmpeg.exec(['-i','/in.msf','-f','msf','/out.msf']);expect(muxed.exitCode).not.toBe(0);expect(muxed.diagnostics.at(-1)?.message).toMatch(/Output requires/);
  expect(opens).toBe(1);
});
