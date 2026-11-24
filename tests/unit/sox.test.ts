import {expect,it} from 'vitest';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {openSox,muxSox,probeSox,validateSoxOutput,sox} from '../../packages/containers/src/sox.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
// header_size, sample words, rate, channels, comment size; payload s32 words.
function fixture(little=true,{headerSize=28,rate=8000,channels=2,comment=0,words=[1,-2,3,-4],count=4n}:{headerSize?:number;rate?:number;channels?:number;comment?:number;words?:number[];count?:bigint}={}){
  const offset=Math.max(headerSize+4,32),bytes=new Uint8Array(offset+words.length*4),view=new DataView(bytes.buffer);
  bytes.set(little?[0x2e,0x53,0x6f,0x58]:[0x58,0x6f,0x53,0x2e]);view.setUint32(4,headerSize,little);view.setBigUint64(8,count,little);view.setFloat64(16,rate,little);view.setUint32(24,channels>>>0,little);view.setUint32(28,comment,little);
  words.forEach((word,i)=>view.setInt32(offset+i*4,word,little));return bytes;
}
async function collect(input:Awaited<ReturnType<typeof openSox>>,start=0n){const result:MediaPacket[]=[];for await(const packet of input.packets(start))result.push(packet);return result;}
async function* packets(data:Uint8Array,channels:number,rate=8000):AsyncIterable<MediaPacket>{if(data.length){const duration=BigInt(data.length/(4*channels));yield {streamIndex:0,data,pts:0n,dts:0n,duration,timeBase:{num:1n,den:BigInt(rate)},flags:1};}}
it('parses both byte orders skips header padding without reads and seeks by frame',async()=>{
  for(const little of [true,false])for(const headerSize of [28,60]){
    const requests:Array<{offset:bigint;length:number}>=[],bytes=fixture(little,{headerSize}),input=await openSox(memoryInput(bytes,requests),{maxReadBytes:8});
    expect(input.info).toMatchObject({container:'sox',codec:little?'pcm_s32le':'pcm_s32be',channels:2,sampleRate:8000,channelMask:null,blockAlign:8,durationSamples:2n,dataOffset:BigInt(headerSize+4),headerSize,declaredSamples:4n});
    expect(requests.filter(request=>request.offset<32n).every(request=>request.length<=8)).toBe(true);expect(requests.some(request=>request.offset>=32n&&request.offset<BigInt(headerSize+4))).toBe(false);
    const all=await collect(input),tail=await collect(input,1n);expect(all.map(packet=>[packet.pts,packet.data.length])).toEqual([[0n,8],[1n,8]]);expect(tail.map(packet=>[packet.pts,[...packet.data]])).toEqual([[1n,[...bytes.subarray(headerSize+12)]]]);
    await expect(collect(input,3n)).rejects.toThrow('seek');
  }
  expect((await openSox(memoryInput(fixture(true,{rate:44100.75})),{maxReadBytes:8})).info.sampleRate).toBe(44100);
  expect((await openSox(memoryInput(fixture(true,{rate:2147483647})),{maxReadBytes:8})).info.sampleRate).toBe(2147483647);
  expect((await openSox(memoryInput(fixture(true,{words:[]})),{maxReadBytes:8})).info.durationSamples).toBe(0n);
});
it('probes both magics and the zero-padded 28-byte probe words like sox_probe',async()=>{
  for(const little of [true,false]){const requests:Array<{offset:bigint;length:number}>=[];expect(await detectAudioContainer(memoryInput(fixture(little),requests),4)).toBe('sox');expect(Math.max(...requests.map(request=>Number(request.offset)+request.length))).toBe(28);}
  expect(await probeSox(memoryInput(fixture(true,{headerSize:0})),64)).toBe(false);expect(await probeSox(memoryInput(fixture(true,{channels:0})),64)).toBe(false);
  expect(await probeSox(memoryInput(fixture().subarray(0,26)),64)).toBe(true);expect(await probeSox(memoryInput(fixture().subarray(0,24)),64)).toBe(false);
  await expect(detectAudioContainer(memoryInput(fixture(true,{channels:0})),4)).rejects.toThrow('Unsupported audio container signature');
  await expect(probeSox(memoryInput(fixture()),0)).rejects.toThrow('budget');
});
it('refuses native-invalid headers with INVALIDDATA and unmirrored ones explicitly',async()=>{
  const invalid=[{headerSize:32},{headerSize:20},{channels:0},{channels:65536},{channels:-1},{rate:Number.NaN},{rate:-8000},{rate:0},{rate:2147483648},{rate:Infinity},{comment:0xffffffe4},{headerSize:28,comment:8}];
  for(const fields of invalid){const error=await openSox(memoryInput(fixture(true,fields)),{maxReadBytes:64}).then(()=>null,(failure:unknown)=>failure as {code:string;exitCode:number;message:string});expect([error?.code,error?.exitCode],JSON.stringify(fields)).toEqual(['unsupported-command',183]);}
  await expect(openSox(memoryInput(fixture(true,{headerSize:36,comment:8})),{maxReadBytes:64})).rejects.toThrow('comment metadata is not implemented');
  await expect(openSox(memoryInput(fixture(true,{rate:0.5})),{maxReadBytes:64})).rejects.toThrow('below 1 Hz');
  await expect(openSox(memoryInput(fixture().subarray(0,31)),{maxReadBytes:64})).rejects.toThrow('Truncated SoX header');
  await expect(openSox(memoryInput(fixture(true,{headerSize:124,words:[]}).subarray(0,64)),{maxReadBytes:64})).rejects.toThrow('exceeds input');
  await expect(openSox(memoryInput(fixture(true,{words:[1,2,3]})),{maxReadBytes:64})).rejects.toThrow('Incomplete');
  const other=fixture();other.set([0x2e,0x73,0x6e,0x64]);await expect(openSox(memoryInput(other),{maxReadBytes:64})).rejects.toThrow('Unsupported SoX magic');
  await expect(openSox(memoryInput(fixture()),{maxReadBytes:0})).rejects.toThrow('budget');
});
it('round-trips the header within a 128-byte budget and writes the sample-word count up front',async()=>{
  for(const codec of ['pcm_s32le','pcm_s32be'] as const)for(const maxWriteBytes of [5,128]){
    const little=codec==='pcm_s32le',sink=collectingOutput(),payload=fixture(little,{channels:3,rate:44100,words:[1,2,3,4,5,6]}).subarray(32);
    await muxSox(sink.output,{codec,channels:3,sampleRate:44100},packets(payload,3,44100),{sampleCount:2n,maxWriteBytes});
    expect(sink.committed).toBe(true);expect(sink.lengths.every(length=>length<=maxWriteBytes)).toBe(true);expect(sink.bytes()).toEqual(fixture(little,{channels:3,rate:44100,words:[1,2,3,4,5,6],count:6n}));
    const requests:Array<{offset:bigint;length:number}>=[],input=await openSox(memoryInput(sink.bytes(),requests),{maxReadBytes:128});expect(input.info).toMatchObject({codec,channels:3,sampleRate:44100,durationSamples:2n,declaredSamples:6n});expect(requests).toEqual([{offset:0n,length:32}]);
  }
  expect(()=>validateSoxOutput({codec:'pcm_s16le' as never,channels:1,sampleRate:8000},0n)).toThrow('codec');
  expect(()=>validateSoxOutput({codec:'pcm_s32le',channels:65536,sampleRate:8000},0n)).toThrow('parameters');
  expect(()=>validateSoxOutput({codec:'pcm_s32le',channels:1,sampleRate:0},0n)).toThrow('parameters');
});
it('aborts SoX output exactly once and honors cancellation before reads',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(openSox(memoryInput(fixture()),{maxReadBytes:8,signal:controller.signal})).rejects.toThrow('stop');
  await expect(probeSox(memoryInput(fixture()),8,controller.signal)).rejects.toThrow('stop');
  const sink=collectingOutput();let aborted=0;
  await expect(muxSox({...sink.output,async abort(reason){aborted++;await sink.output.abort(reason);}},{codec:'pcm_s32le',channels:1,sampleRate:8000},packets(new Uint8Array(8),1),{sampleCount:3n,maxWriteBytes:7})).rejects.toThrow('duration');
  expect(aborted).toBe(1);expect(sink.aborted).toBe(true);expect(sink.committed).toBe(false);expect(sink.lengths).toEqual([]);
  const early=collectingOutput();let earlyAborts=0;
  await expect(muxSox({...early.output,async abort(reason){earlyAborts++;await early.output.abort(reason);}},{codec:'pcm_s32le',channels:1,sampleRate:8000},packets(new Uint8Array(0),1),{sampleCount:0n,maxWriteBytes:0})).rejects.toThrow('budget');expect(earlyAborts).toBe(1);
});
it('registers the sox descriptor fields',()=>{
  expect(containerFormat('sox')).toBe(sox);
  expect(sox.demux).toMatchObject({headerBytes:32,probe:{precedence:100}});expect('packetSpan' in sox.demux||'seekBeyondEnd' in sox.demux).toBe(false);
  expect(sox.mux).toMatchObject({label:'SoX',extensions:['.sox'],defaultCodec:'pcm_s32le',scratchBytes:32});expect('dropsMetadata' in sox.mux).toBe(false);
  expect([sox.mux.supports('pcm_s32le'),sox.mux.supports('pcm_s32be'),sox.mux.supports('pcm_s16le'),sox.mux.supports('pcm_f32le')]).toEqual([true,true,false,false]);
  const refusal=sox.mux.refuse('pcm_s16le') as Error&{code:string;exitCode:number};expect([refusal.code,refusal.exitCode]).toEqual(['unsupported-command',234]);
  expect(sox.demux.probe.head(Uint8Array.from([0x2e,0x53,0x6f,0x58]))).toBe(true);expect(sox.demux.probe.head(Uint8Array.from([0x58,0x6f,0x53,0x2e]))).toBe(true);expect(sox.demux.probe.head(Uint8Array.from([0x2e,0x73,0x6e,0x64]))).toBe(false);
  expect(Object.isFrozen(sox)&&Object.isFrozen(sox.demux)&&Object.isFrozen(sox.mux)).toBe(true);
});
