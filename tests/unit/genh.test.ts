import {expect,it} from 'vitest';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import {ExecutionError} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {genh,matchesGenh,openGenh,probeGenh,GenhError} from '../../packages/containers/src/genh.js';
import {memoryInput} from '../helpers/wav.js';
interface Fields {channels?:number;interleave?:number;rate?:number;codec?:number;start?:number;headerSize?:number;duration?:number}
function header({channels=2,interleave=2,rate=8000,codec=13,start=60,headerSize=start,duration=0}:Fields,payload:number[]=[],pad=0):Uint8Array{
  const bytes=new Uint8Array(60+pad+payload.length),view=new DataView(bytes.buffer);bytes.set([0x47,0x45,0x4e,0x48]);
  for(const [index,value] of [channels,interleave,rate,0xdeadbeef,duration,codec,start,headerSize,7,7,7,7,7,7].entries())view.setUint32(4+index*4,value>>>0,true);
  bytes.fill(0xee,60,60+pad);bytes.set(payload,60+pad);
  return bytes;
}
const range=(length:number,from=1)=>Array.from({length},(_,index)=>(from+index)&255);
async function collect(input:Awaited<ReturnType<typeof openGenh>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
async function failure(bytes:Uint8Array,seek=0n){try{await openGenh(memoryInput(bytes),{maxReadBytes:64,seek});}catch(error){return error;}throw new Error('opened');}
it('parses the 60-byte GENH header with bounded reads and serves pcm_u8 from start_offset',async()=>{
  const requests:Array<{offset:bigint;length:number}>=[],bytes=header({channels:2,interleave:3,rate:11025,duration:99},range(12)),input=await openGenh(memoryInput(bytes,requests),{maxReadBytes:7});
  expect(input.info).toMatchObject({container:'genh',codec:'pcm_u8',channels:2,sampleRate:11025,channelMask:3,bitsPerSample:8,blockAlign:2,dataOffset:60n,startOffset:60n,dataBytes:12n,durationSamples:6n,interleave:3,headerDuration:99n});
  expect('copyRefusal' in input.info).toBe(false);
  expect(requests.every(request=>request.length<=7&&request.offset<60n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(60);
  requests.length=0;const packets=await collect(input,4n,4);
  expect(packets.map(packet=>[packet.pts,packet.duration,[...packet.data]])).toEqual([[4n,2n,[9,10,11,12]]]);expect(requests.every(request=>request.offset>=68n)).toBe(true);
  expect(genh.demux.packetSpan!(input.info)).toBe(3n);
  // Channel layouts: mono and stereo native masks, otherwise unspecified.
  expect((await openGenh(memoryInput(header({channels:1,interleave:100},range(100))),{maxReadBytes:64})).info).toMatchObject({channels:1,channelMask:4,durationSamples:100n});
  expect((await openGenh(memoryInput(header({channels:5,interleave:1},range(10))),{maxReadBytes:64})).info).toMatchObject({channels:5,channelMask:null,blockAlign:5,durationSamples:2n});
});
it('applies the start_offset and header_size rules: absolute start, 0x800 for header_size 0, and a start inside the header',async()=>{
  const padded=header({start:0,headerSize:0,channels:1,interleave:4},range(8,40),0x800-60),zero=await openGenh(memoryInput(padded),{maxReadBytes:64});
  expect(zero.info).toMatchObject({startOffset:0x800n,dataBytes:8n,durationSamples:8n});expect([...(await collect(zero))[0]!.data]).toEqual(range(8,40));
  const inside=header({start:16,headerSize:16,channels:4,interleave:1},range(4)),early=await openGenh(memoryInput(inside),{maxReadBytes:64});
  expect(early.info).toMatchObject({startOffset:16n,dataBytes:48n,durationSamples:12n});expect([...(await collect(early)).flatMap(packet=>[...packet.data])]).toEqual([...inside.subarray(16)]);
  const later=await openGenh(memoryInput(header({start:70,headerSize:20,channels:1,interleave:5},range(5),10)),{maxReadBytes:64});expect(later.info).toMatchObject({startOffset:70n,dataBytes:5n});
  // header_size above start_offset is AVERROR_INVALIDDATA; equal is accepted.
  expect(await failure(header({start:60,headerSize:61},range(4)))).toMatchObject({code:'unsupported-command',exitCode:183});
  expect((await failure(header({start:0,headerSize:0},range(4))) as Error).message).toContain('without payload');
  expect((await failure(header({start:64,headerSize:0x40}))) as Error).toBeInstanceOf(GenhError);
});
it('refuses GENH headers in native order with native exit statuses and unported codecs explicitly',async()=>{
  // AVERROR_INVALIDDATA 183, AVERROR_PATCHWELCOME 176, AVERROR(EINVAL) 234 on Linux.
  for(const [fields,code,message] of [[{channels:0},183,'channel'],[{channels:0x80000000},183,'channel'],[{interleave:0x80000000},183,'interleave'],[{channels:3,interleave:0x2aaaaaab},183,'interleave'],
    [{rate:0x80000000},183,'sample rate'],[{codec:8},176,'codec 8'],[{codec:0xffffffff},176,'codec 4294967295'],[{codec:1,channels:59652324,interleave:0},183,'channel'],[{codec:6,channels:1,interleave:2097152},183,'block'],
    [{interleave:0},183,'block'],[{codec:4,interleave:0},183,'block'],[{codec:4,headerSize:61},183,'header size'],[{codec:8,headerSize:61},176,'codec 8'],[{rate:0},234,'rate 0']] as const){
    const error=await failure(header(fields,range(8)));expect(error,JSON.stringify(fields)).toBeInstanceOf(ExecutionError);expect(error).toMatchObject({code:'unsupported-command',exitCode:code});expect((error as Error).message).toContain(message);
  }
  for(const [codec,name] of [[0,'adpcm_psx'],[1,'adpcm_ima_wav'],[2,'adpcm_dtk'],[3,'pcm_s16be_planar'],[4,'pcm_s16le_planar'],[5,'pcm_s8_planar'],[6,'sdx2_dpcm'],[7,'adpcm_ima_ws'],[10,'adpcm_aica'],[11,'adpcm_ima_wav'],[12,'adpcm_thp'],[17,'adpcm_ima_qt']] as const){
    const error=await failure(header({codec},range(8)));expect(error,`${codec}`).toBeInstanceOf(GenhError);expect((error as Error).message).toContain(`codec ${codec} (${name})`);
  }
  for(const [bytes,message] of [[header({channels:2},range(7)),'partial trailing'],[header({channels:70000,interleave:1},range(8)),'channel count 70000'],[header({}).subarray(0,59),'Truncated']] as const){
    const error=await failure(bytes);expect(error).toBeInstanceOf(GenhError);expect((error as Error).message).toContain(message);
  }
  // Input -ss is refused once the header is valid; an invalid header keeps its own status.
  expect(await failure(header({},range(8)),1n)).toMatchObject({code:'unsupported-command',message:'GENH input seeking is not implemented'});
  expect(await failure(header({channels:0},range(8)),1n)).toMatchObject({exitCode:183});
  await expect(openGenh(memoryInput(header({},range(8))),{maxReadBytes:0})).rejects.toThrow('budget');
});
it('marks a short final packet for the copy refusal and keeps whole-packet inputs copyable',async()=>{
  const short=await openGenh(memoryInput(header({channels:2,interleave:3},range(10))),{maxReadBytes:64});
  expect(short.info).toMatchObject({durationSamples:5n,copyRefusal:'GENH stream copy of a short final packet is not implemented'});
  expect([...(await collect(short)).flatMap(packet=>[...packet.data])]).toEqual(range(10));
  expect('copyRefusal' in (await openGenh(memoryInput(header({channels:2,interleave:3},range(12))),{maxReadBytes:64})).info).toBe(false);
  expect('copyRefusal' in (await openGenh(memoryInput(header({channels:1,interleave:1},range(3))),{maxReadBytes:64})).info).toBe(false);
});
it('aborts GENH opens, probes and packet reads on the signal',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(openGenh(memoryInput(header({},range(4))),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stop');
  await expect(probeGenh(memoryInput(header({})),64,controller.signal)).rejects.toThrow('stop');
  const live=new AbortController(),bytes=header({channels:1,interleave:1},range(4));let reads=0;
  const input=await openGenh({size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===2)live.abort(new Error('halt'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}},{maxReadBytes:64,signal:live.signal});
  await expect(collect(input,0n,1)).rejects.toThrow('halt');
  const midHeader=new AbortController();
  await expect(openGenh({size:BigInt(bytes.length),async readAt(offset,length){midHeader.abort(new Error('mid'));return bytes.slice(Number(offset),Number(offset)+length);}},{maxReadBytes:16,signal:midHeader.signal})).rejects.toThrow('mid');
});
it('registers a demux-only genh descriptor detected by GENH and a channel count in 1..0xFFFF',async()=>{
  expect(containerFormat('genh')).toBe(genh);expect(genh.name).toBe('genh');expect('mux' in genh).toBe(false);expect('extensions' in genh.demux).toBe(false);
  expect(genh.demux.headerBytes).toBe(60);expect(genh.demux.probe.precedence).toBe(100);expect(Object.isFrozen(genh)&&Object.isFrozen(genh.demux)&&Object.isFrozen(genh.demux.probe)).toBe(true);
  expect(genh.demux.probe.head(Uint8Array.from([0x47,0x45,0x4e,0x48]))).toBe(true);expect(genh.demux.probe.head(Uint8Array.from([0x47,0x45,0x4e,0x49]))).toBe(false);
  for(const [channels,match] of [[1,true],[0xffff,true],[0,false],[0x10000,false],[0x80000000,false]] as const)expect(matchesGenh(header({channels})),`${channels}`).toBe(match);
  expect(matchesGenh(Uint8Array.from([0x47,0x45,0x4e,0x48,1]))).toBe(true);expect(matchesGenh(Uint8Array.from([0x47,0x45,0x4e,0x48]))).toBe(false);
  const requests:Array<{offset:bigint;length:number}>=[];expect(await probeGenh(memoryInput(header({}),requests),3)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(8);expect(requests.every(request=>request.length<=3)).toBe(true);
  expect(await probeGenh(memoryInput(Uint8Array.from([0x47,0x45,0x4e,0x48,2,0])),64)).toBe(true);
  await expect(probeGenh(memoryInput(header({})),0)).rejects.toThrow('budget');
  requests.length=0;expect(await detectAudioContainer(memoryInput(header({},range(8)),requests),64)).toBe('genh');expect(requests.every(request=>request.offset<8n)).toBe(true);
  await expect(detectAudioContainer(memoryInput(header({channels:0},range(8))),64)).rejects.toThrow('Unsupported audio container signature');
  const opened=await genh.demux.open(memoryInput(header({channels:1,interleave:2},range(2))),{maxReadBytes:64,signal:new AbortController().signal,declared:{channels:2,sampleRate:44100,guessLayout:true},seek:0n});
  expect(opened.info).toMatchObject({codec:'pcm_u8',channels:1,sampleRate:8000,durationSamples:2n});
  await expect(genh.demux.open(memoryInput(header({},range(4))),{maxReadBytes:64,signal:new AbortController().signal,declared:{channels:1,sampleRate:44100,guessLayout:true},seek:5n})).rejects.toThrow('seeking');
});
