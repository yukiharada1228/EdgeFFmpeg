import {expect,it} from 'vitest';
import {containerFormat,detectAudioContainer,inputContainerFor,outputContainerFor} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {openRso,muxRso,validateRsoOutput,rso} from '../../packages/containers/src/rso.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
function fixture(tag=0x0100,size=3,rate=8000,data=[128,0,127]){const bytes=new Uint8Array(8+data.length),view=new DataView(bytes.buffer);view.setUint16(0,tag,false);view.setUint16(2,size,false);view.setUint16(4,rate,false);view.setUint16(6,0x1234,false);bytes.set(data,8);return bytes;}
async function collect(input:Awaited<ReturnType<typeof openRso>>,start=0n,max?:number){const result=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
function packet(data:number[],pts=0n):MediaPacket{return {streamIndex:0,data:new Uint8Array(data),pts,dts:pts,duration:BigInt(data.length),timeBase:{num:1n,den:8000n},flags:1};}
async function* packets(...list:MediaPacket[]):AsyncIterable<MediaPacket>{yield* list;}
it('parses the RSO header with bounded reads and reads pcm_u8 mono to EOF whatever the header size',async()=>{
  for(const size of [0,1,3,0xffff]){
    const requests:Array<{offset:bigint;length:number}>=[],input=await openRso(memoryInput(fixture(0x0100,size,11025),requests),{maxReadBytes:1});
    expect(input.info).toMatchObject({container:'rso',codec:'pcm_u8',channels:1,sampleRate:11025,channelMask:null,blockAlign:1,bitsPerSample:8,dataOffset:8n,dataBytes:3n,durationSamples:3n,declaredDataBytes:size});
    expect(requests.length).toBe(8);expect(requests.every((request,i)=>request.length===1&&request.offset===BigInt(i))).toBe(true);
    const all=await collect(input,1n,1);expect(all.map(packet=>[packet.pts,[...packet.data]])).toEqual([[1n,[0]],[2n,[127]]]);expect(all[0]!.timeBase).toEqual({num:1n,den:11025n});
    await expect(collect(input,4n)).rejects.toThrow('seek');
  }
  expect((await openRso(memoryInput(fixture(0x0100,0,65535,[])),{maxReadBytes:64})).info.durationSamples).toBe(0n);
});
it('refuses truncated headers ADPCM unknown tags rate 0 and invalid budgets with native statuses where native has one',async()=>{
  await expect(openRso(memoryInput(fixture().subarray(0,7)),{maxReadBytes:8})).rejects.toThrow('Truncated RSO header');
  for(const tag of [0x0101,0x0200,0,0x0001]){const error=await openRso(memoryInput(fixture(tag)),{maxReadBytes:8}).catch((error:unknown)=>error);expect(error).toMatchObject({code:'unsupported-command',exitCode:176});expect(String(error)).toMatch(tag===0x0101?/ADPCM in RSO/:/Unsupported RSO codec tag/);}
  await expect(openRso(memoryInput(fixture(0x0100,3,0)),{maxReadBytes:8})).rejects.toThrow('sample rate 0');
  for(const maxReadBytes of [0,1.5,Number.NaN])await expect(openRso(memoryInput(fixture()),{maxReadBytes})).rejects.toThrow('read budget');
  const controller=new AbortController();controller.abort(new Error('stop'));await expect(openRso(memoryInput(fixture()),{maxReadBytes:8,signal:controller.signal})).rejects.toThrow('stop');
  const short={size:16n,async readAt(){return new Uint8Array(9);}};await expect(openRso(short,{maxReadBytes:8})).rejects.toThrow('read length');
});
it('refuses RSO outputs in native write_header order with exit 183 and writes min(samples,0xffff) up front',async()=>{
  const status=(format:Parameters<typeof validateRsoOutput>[0],samples=1n)=>{try{validateRsoOutput(format,samples);return null;}catch(error){return [(error as {exitCode?:number}).exitCode,(error as Error).message];}};
  expect(status({codec:'pcm_s16le',channels:2,sampleRate:70000})).toEqual([183,'RSO muxer does not support pcm_s16le']);
  expect(status({codec:'pcm_u8',channels:2,sampleRate:70000})).toEqual([183,'RSO only supports mono']);
  for(const sampleRate of [65536,70000])expect(status({codec:'pcm_u8',channels:1,sampleRate})).toEqual([183,'Sample rate must be < 65536']);
  expect(status({codec:'pcm_u8',channels:1,sampleRate:65535})).toBeNull();expect(()=>validateRsoOutput({codec:'pcm_u8',channels:1,sampleRate:0},1n)).toThrow('sample rate');expect(()=>validateRsoOutput({codec:'pcm_u8',channels:1,sampleRate:8000},-1n)).toThrow('sample count');
  for(const [samples,coded] of [[0n,0],[1n,1],[65535n,0xffff],[65536n,0xffff],[70000n,0xffff]] as const){
    const sink=collectingOutput(),data=Array.from({length:Number(samples)},(_,i)=>i&255);
    await muxRso(sink.output,{codec:'pcm_u8',channels:1,sampleRate:8000},samples?packets(packet(data)):packets(),{sampleCount:samples,maxWriteBytes:3});
    const bytes=sink.bytes();expect(sink.committed).toBe(true);expect(sink.lengths.slice(0,3)).toEqual([3,3,2]);expect(sink.lengths.every(length=>length<=3)).toBe(true);
    expect([...bytes.subarray(0,8)]).toEqual([1,0,coded>>8,coded&255,0x1f,0x40,0,0]);expect(bytes.length).toBe(8+Number(samples));expect([...bytes.subarray(8,12)]).toEqual(data.slice(0,4));
  }
});
it('aborts RSO output exactly once on failed packets invalid budgets and cancellation',async()=>{
  for(const [list,sampleCount,maxWriteBytes,message] of [[[packet([1,2,3])],4n,7,'duration'],[[packet([1,2,3])],3n,0,'write budget'],[[packet([1,2],5n)],2n,7,'timestamps']] as const){
    const sink=collectingOutput();let aborted=0;
    await expect(muxRso({...sink.output,async abort(reason){aborted++;await sink.output.abort(reason);}},{codec:'pcm_u8',channels:1,sampleRate:8000},packets(...list),{sampleCount,maxWriteBytes})).rejects.toThrow(message);
    expect(aborted).toBe(1);expect(sink.aborted).toBe(true);expect(sink.committed).toBe(false);
  }
  const sink=collectingOutput(),controller=new AbortController();let aborted=0;controller.abort(new Error('halt'));
  await expect(muxRso({...sink.output,async abort(reason){aborted++;await sink.output.abort(reason);}},{codec:'pcm_u8',channels:1,sampleRate:8000},packets(packet([1])),{sampleCount:1n,maxWriteBytes:8,signal:controller.signal})).rejects.toThrow('halt');expect(aborted).toBe(1);expect(sink.lengths).toEqual([]);
  const refused=collectingOutput();let refusedAborts=0;
  await expect(muxRso({...refused.output,async abort(reason){refusedAborts++;await refused.output.abort(reason);}},{codec:'pcm_u8',channels:2,sampleRate:8000},packets(),{sampleCount:0n,maxWriteBytes:8})).rejects.toThrow('mono');expect(refusedAborts).toBe(1);expect(refused.lengths).toEqual([]);
});
it('registers RSO as an extension-only demuxer and a pcm_u8 .rso muxer',async()=>{
  expect(containerFormat('rso')).toBe(rso);expect(Object.isFrozen(rso)&&Object.isFrozen(rso.demux)&&Object.isFrozen(rso.mux)).toBe(true);
  expect(rso.demux).toMatchObject({extensions:['.rso'],headerBytes:8});expect(['probe','packetSpan','seekBeyondEnd'].some(key=>key in rso.demux)).toBe(false);
  expect(rso.mux).toMatchObject({label:'RSO',extensions:['.rso'],defaultCodec:'pcm_u8',scratchBytes:8,dropsMetadata:true});expect(['order','options'].some(key=>key in rso.mux)).toBe(false);
  expect(rso.mux.supports('pcm_u8')).toBe(true);for(const codec of ['pcm_s8','pcm_s16le','pcm_s16be','pcm_alaw'] as const){expect(rso.mux.supports(codec)).toBe(false);expect(rso.mux.refuse(codec)).toMatchObject({code:'unsupported-command',exitCode:183,message:`RSO muxer does not support ${codec}`});}
  expect(inputContainerFor('/a/B.RSO')?.name).toBe('rso');expect(outputContainerFor('/x.rso')?.name).toBe('rso');expect(outputContainerFor('/x.rso.wav')?.name).toBe('wav');
  const bytes=fixture(),requests:Array<{offset:bigint;length:number}>=[];
  expect(await detectAudioContainer(memoryInput(bytes,requests),64,undefined,'/in.rso')).toBe('rso');expect(requests).toEqual([{offset:0n,length:4}]);
  await expect(detectAudioContainer(memoryInput(bytes),64,undefined,'/in.dat')).rejects.toThrow('Unsupported audio container signature');await expect(detectAudioContainer(memoryInput(bytes),64)).rejects.toThrow('Unsupported audio container signature');
  const opened=await rso.demux.open(memoryInput(bytes),{maxReadBytes:8,signal:new AbortController().signal,declared:{sampleRate:44100,channels:2,guessLayout:true},seek:0n});expect(opened.info).toMatchObject({sampleRate:8000,channels:1});
});
