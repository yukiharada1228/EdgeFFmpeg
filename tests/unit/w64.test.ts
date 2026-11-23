import {expect,it} from 'vitest';
import {openW64,probeW64,muxW64,validateW64Output,supportsW64Codec,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {memoryInput,pcmFormat} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
// GUIDs as listed in libavformat/w64.c; independent of the implementation's tables.
const tail=[0xf3,0xac,0xd3,0x11,0x8c,0xd1,0x00,0xc0,0x4f,0x8e,0xdb,0x8a];
const guid=(id:string,rest=tail)=>[...[...id].map(c=>c.charCodeAt(0)),...rest];
const riff=guid('riff',[0x2e,0x91,0xcf,0x11,0xa5,0xd6,0x28,0xdb,0x04,0xc1,0x00,0x00]),summary=[0xbc,0x94,0x5f,0x92,0x5a,0x52,0xd2,0x11,0x86,0xdc,0x00,0xc0,0x4f,0x8e,0xdb,0x8a];
function chunk(id:number[],payload:Uint8Array,size=BigInt(24+payload.length)):Uint8Array{const bytes=new Uint8Array(24+payload.length+(-(24+payload.length)&7));bytes.set(id);new DataView(bytes.buffer).setBigUint64(16,size,true);bytes.set(payload,24);return bytes;}
function w64(chunks:Uint8Array[],riffSize?:bigint,wave=guid('wave')):Uint8Array{const length=40+chunks.reduce((sum,data)=>sum+data.length,0),bytes=new Uint8Array(length);bytes.set(riff);new DataView(bytes.buffer).setBigUint64(16,riffSize??BigInt(length),true);bytes.set(wave,24);let offset=40;for(const data of chunks){bytes.set(data,offset);offset+=data.length;}return bytes;}
const u64=(value:bigint)=>{const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigInt64(0,value,true);return bytes;};
// Chunks that follow data use 8-byte payloads: native skips data without realignment.
const fmt=(channels=1,rate=8000,bits=16)=>chunk(guid('fmt '),pcmFormat(channels,rate,bits)),data=(payload:Uint8Array,size?:bigint)=>chunk(guid('data'),payload,size);
async function collect(input:Awaited<ReturnType<typeof openW64>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
it('walks W64 GUID chunks with bounded reads skips unknown chunks without payload reads and seeks',async()=>{
  const pcm=Uint8Array.from([1,0,2,0,3,0,4,0]),unknown=chunk(guid('junk'),new Uint8Array(4093)),bytes=w64([unknown,fmt(),chunk(guid('fact'),u64(3n)),data(pcm),chunk(guid('tail'),new Uint8Array(5))]);
  const requests:Array<{offset:bigint;length:number}>=[],input=await openW64(memoryInput(bytes,requests),{maxReadBytes:2});
  const dataOffset=BigInt(40+unknown.length+40+32+24);
  expect(input.info).toMatchObject({container:'w64',codec:'pcm_s16le',channels:1,sampleRate:8000,blockAlign:2,channelMask:null,dataOffset,dataBytes:8n,durationSamples:4n,factSamples:3n});
  expect(requests.every(request=>request.length<=2)).toBe(true);
  // Only GUID headers, the fmt payload and the fact count are read while opening.
  expect(requests.some(request=>request.offset>=64n&&request.offset<BigInt(40+unknown.length))).toBe(false);expect(requests.some(request=>request.offset>=dataOffset&&request.offset<dataOffset+8n)).toBe(false);
  requests.length=0;const packets=await collect(input,1n,2);
  expect(packets.map(packet=>[packet.pts,packet.duration,[...packet.data]])).toEqual([[1n,1n,[2,0]],[2n,1n,[3,0]],[3n,1n,[4,0]]]);expect(requests.every(request=>request.offset>=dataOffset+2n&&request.offset<dataOffset+8n)).toBe(true);
  await expect(collect(input,5n)).rejects.toThrow('seek');
  expect(await detectAudioContainer(memoryInput(bytes),1)).toBe('w64');expect(await probeW64(memoryInput(bytes),3)).toBe(true);
});
it('detects W64 only from the native riff and wave GUIDs over more than forty bytes',async()=>{
  const valid=w64([fmt(),data(new Uint8Array(2))]);
  expect(await probeW64(memoryInput(valid.subarray(0,40)),64)).toBe(false);
  const wrongWave=w64([fmt(),data(new Uint8Array(2))],undefined,guid('WAVE'));expect(await probeW64(memoryInput(wrongWave),64)).toBe(false);await expect(detectAudioContainer(memoryInput(wrongWave),64)).rejects.toThrow('signature');
  const wrongRiff=valid.slice();wrongRiff[4]=0;expect(await probeW64(memoryInput(wrongRiff),64)).toBe(false);await expect(detectAudioContainer(memoryInput(wrongRiff),64)).rejects.toThrow('signature');
  await expect(probeW64(memoryInput(valid),0)).rejects.toThrow('budget');
  // Existing magic numbers keep their four-byte probe.
  const requests:Array<{offset:bigint;length:number}>=[];expect(await detectAudioContainer(memoryInput(new TextEncoder().encode('RIFF....WAVE'),requests),64)).toBe('wav');expect(requests).toEqual([{offset:0n,length:4}]);
});
it('maps W64 fmt payloads like WAV and keeps the alignment padding inside the data size as native does',async()=>{
  for(const [bits,codec] of [[8,'pcm_u8'],[16,'pcm_s16le'],[24,'pcm_s24le'],[32,'pcm_s32le']] as const)expect((await openW64(memoryInput(w64([fmt(2,44100,bits),data(new Uint8Array(bits/4*4))])),{maxReadBytes:64})).info.codec).toBe(codec);
  const extensible=new Uint8Array(40),view=new DataView(extensible.buffer);extensible.set(pcmFormat(2,96000,32));view.setUint16(0,0xfffe,true);view.setUint16(16,22,true);view.setUint16(18,32,true);view.setUint32(20,3,true);view.setUint32(24,3,true);extensible.set([0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71],28);
  expect((await openW64(memoryInput(w64([chunk(guid('fmt '),extensible),data(new Uint8Array(16))])),{maxReadBytes:64})).info).toMatchObject({codec:'pcm_f32le',channelMask:3,durationSamples:2n});
  view.setUint32(20,7,true);expect((await openW64(memoryInput(w64([chunk(guid('fmt '),extensible),data(new Uint8Array(16))])),{maxReadBytes:64})).info.channelMask).toBeNull();
  const alaw=new Uint8Array(18),alawView=new DataView(alaw.buffer);alaw.set(pcmFormat(1,8000,8));alawView.setUint16(0,6,true);
  const padded=await openW64(memoryInput(w64([chunk(guid('fmt '),alaw),chunk(guid('fact'),u64(3n)),data(Uint8Array.from([1,2,3,0,0,0,0,0]))])),{maxReadBytes:64});
  expect(padded.info).toMatchObject({codec:'pcm_alaw',factSamples:3n,durationSamples:8n});
  // A chunk size of 24 or less ends the walk once data was found.
  const stop=await openW64(memoryInput(w64([fmt(),data(new Uint8Array(8)),chunk(guid('junk'),new Uint8Array(8),0n)])),{maxReadBytes:64});expect(stop.info.durationSamples).toBe(4n);
});
it('rejects malformed limited metadata-bearing and partial-frame W64 explicitly',async()=>{
  const open=(bytes:Uint8Array,maxReadBytes=64,maxChunks?:number)=>openW64(memoryInput(bytes),{maxReadBytes,...(maxChunks?{maxChunks}:{})});
  const valid=w64([fmt(),data(new Uint8Array(2))]);
  await expect(open(valid.subarray(0,39))).rejects.toThrow('Truncated W64 header');
  const badRiff=valid.slice();badRiff[0]=0x52;await expect(open(badRiff)).rejects.toThrow('riff GUID');
  await expect(open(w64([fmt(),data(new Uint8Array(2))],71n))).rejects.toThrow('riff size');
  await expect(open(w64([fmt(),data(new Uint8Array(2))],72n))).resolves.toBeDefined();
  await expect(open(w64([fmt(),data(new Uint8Array(2))],undefined,guid('WAVE')))).rejects.toThrow('wave GUID');
  await expect(open(w64([chunk(guid('junk'),new Uint8Array(8),24n),fmt(),data(new Uint8Array(2))]))).rejects.toThrow('chunk size');
  await expect(open(w64([chunk(guid('junk'),new Uint8Array(8),0xffffffffffffffffn),fmt(),data(new Uint8Array(2))]))).rejects.toThrow('chunk size');
  await expect(open(w64([fmt(),fmt(),data(new Uint8Array(2))]))).rejects.toThrow('Multiple W64 format');
  await expect(open(w64([fmt(),data(new Uint8Array(8)),fmt()]))).rejects.toThrow('Multiple W64 format');
  await expect(open(w64([data(new Uint8Array(2)),fmt()]))).rejects.toThrow('before format');
  await expect(open(w64([fmt(),data(new Uint8Array(8)),data(new Uint8Array(8))]))).rejects.toThrow('Multiple W64 data');
  await expect(open(w64([fmt(),data(new Uint8Array(2),40n)]))).rejects.toThrow('Truncated W64 data');
  await expect(open(w64([fmt(),chunk(guid('fact'),new Uint8Array(4),28n),data(new Uint8Array(2))]))).rejects.toThrow('fact');
  await expect(open(w64([fmt(),chunk(summary,new Uint8Array(4)),data(new Uint8Array(2))]))).rejects.toThrow('summary metadata');
  await expect(open(w64([fmt(1,8000,24),data(new Uint8Array(8))]))).rejects.toThrow('partial sample frame');
  await expect(open(w64([fmt(1,8000,24),data(new Uint8Array(6))]),2)).rejects.toThrow('read budget');
  await expect(open(w64([fmt(1,8000,12),data(new Uint8Array(2))]))).rejects.toThrow('Unsupported W64 encoding');
  const badRate=pcmFormat();new DataView(badRate.buffer).setUint32(8,1,true);await expect(open(w64([chunk(guid('fmt '),badRate),data(new Uint8Array(2))]))).rejects.toThrow('alignment');
  await expect(open(w64([chunk(guid('fmt '),pcmFormat().subarray(0,14)),data(new Uint8Array(2))]))).rejects.toThrow('Truncated W64 format');
  await expect(open(w64([fmt()]))).rejects.toThrow('Missing W64');
  await expect(open(w64([chunk(guid('junk'),new Uint8Array(8)),fmt(),data(new Uint8Array(2))]),64,2)).rejects.toThrow('chunk count');
  await expect(open(valid,0)).rejects.toThrow('read limits');
  const controller=new AbortController();controller.abort(new Error('stop'));await expect(openW64(memoryInput(valid),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stop');
});
it('writes W64 headers in bounded chunks pads data to eight bytes and aborts failed output exactly once',async()=>{
  async function* packets(data:Uint8Array,pts=0n):AsyncIterable<MediaPacket>{yield {streamIndex:0,data,pts,dts:pts,duration:BigInt(Math.floor(data.length/2)),timeBase:{num:1n,den:8000n},flags:1};}
  const sink=collectingOutput();await muxW64(sink.output,{codec:'pcm_s16le',channels:1,sampleRate:8000},packets(Uint8Array.from([1,0,2,0,3,0])),{sampleCount:3n,maxWriteBytes:5});
  const bytes=sink.bytes(),view=new DataView(bytes.buffer);expect(sink.committed).toBe(true);expect(sink.lengths.every(length=>length<=5)).toBe(true);
  expect(bytes.length).toBe(112);expect([...bytes.subarray(0,16)]).toEqual(riff);expect(view.getBigUint64(16,true)).toBe(112n);expect(view.getBigUint64(56,true)).toBe(40n);expect([...bytes.subarray(80,96)]).toEqual(guid('data'));expect(view.getBigUint64(96,true)).toBe(32n);expect([...bytes.subarray(104)]).toEqual([1,0,2,0,3,0,0,0]);
  const empty=collectingOutput();await muxW64(empty.output,{codec:'pcm_mulaw',channels:1,sampleRate:8000},(async function*():AsyncIterable<MediaPacket>{})(),{sampleCount:0n,maxWriteBytes:64});
  const emptyBytes=empty.bytes(),emptyView=new DataView(emptyBytes.buffer);expect(emptyBytes.length).toBe(144);expect([...emptyBytes.subarray(88,104)]).toEqual(guid('fact'));expect(emptyView.getBigUint64(104,true)).toBe(32n);expect(emptyView.getBigUint64(112,true)).toBe(0n);expect(emptyView.getBigUint64(136,true)).toBe(24n);
  for(const [data,pts,count,message] of [[Uint8Array.from([1,0]),0n,2n,'duration'],[Uint8Array.from([1,0]),1n,1n,'timestamps'],[Uint8Array.from([1]),0n,1n,'length'],[Uint8Array.from([1,0,2,0]),0n,1n,'length']] as const){
    const failed=collectingOutput();let aborted=0;await expect(muxW64({...failed.output,async abort(reason){aborted++;await failed.output.abort(reason);}},{codec:'pcm_s16le',channels:1,sampleRate:8000},packets(data,pts),{sampleCount:count,maxWriteBytes:7})).rejects.toThrow(message);expect(aborted).toBe(1);expect(failed.committed).toBe(false);expect(failed.lengths).toEqual([]);
  }
  const controller=new AbortController();controller.abort(new Error('stop'));const cancelled=collectingOutput();await expect(muxW64(cancelled.output,{codec:'pcm_s16le',channels:1,sampleRate:8000},packets(Uint8Array.from([1,0])),{sampleCount:1n,maxWriteBytes:7,signal:controller.signal})).rejects.toThrow('stop');expect(cancelled.aborted).toBe(true);
  await expect(muxW64(collectingOutput().output,{codec:'pcm_s16le',channels:1,sampleRate:8000},packets(Uint8Array.from([1,0])),{sampleCount:1n,maxWriteBytes:0})).rejects.toThrow('write limit');
  expect(()=>validateW64Output({codec:'pcm_s16le',channels:1,sampleRate:8000},(0x7fffffffffffffffn-160n)/2n)).not.toThrow();
  expect(()=>validateW64Output({codec:'pcm_s16le',channels:1,sampleRate:8000},0x4000000000000000n)).toThrow('64-bit');
  expect(()=>validateW64Output({codec:'pcm_s16le',channels:1,sampleRate:8000},-1n)).toThrow('duration');
  expect(()=>validateW64Output({codec:'pcm_s16be' as never,channels:1,sampleRate:8000},1n)).toThrow('codec');
  expect(['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le','pcm_alaw','pcm_mulaw','pcm_s16be','pcm_s8'].map(supportsW64Codec)).toEqual([true,true,true,true,true,true,true,true,false,false]);
});
