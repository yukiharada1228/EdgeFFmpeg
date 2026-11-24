import {expect,it} from 'vitest';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {ircam,ircamPacketSpan,ircamRate,ircamRateBits,muxIrcam,openIrcam,supportsIrcamCodec,validateIrcamOutput} from '../../packages/containers/src/ircam.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
const float=(value:number)=>{const view=new DataView(new ArrayBuffer(4));view.setFloat32(0,value,true);return view.getUint32(0,true);};
function fixture(magic:number,le:boolean,fields:{rate?:number;rateBits?:number;channels?:number;tag?:number}={},payload:number[]=[1,2,3,4]){
  const bytes=new Uint8Array(1024+payload.length),view=new DataView(bytes.buffer);
  view.setUint32(0,magic,true);view.setUint32(4,fields.rateBits??float(fields.rate??8000),le);view.setUint32(8,fields.channels??1,le);view.setUint32(12,fields.tag??2,le);bytes.set(payload,1024);return bytes;
}
const magics:Array<[number,boolean]>=[[0x64a30100,false],[0x64a30200,true],[0x64a30300,false],[0x64a30400,true],[0x0001a364,true],[0x0002a364,false],[0x0003a364,true]];
const leTags:Array<[string,number]>=[['pcm_alaw',0x10001],['pcm_mulaw',0x20001],['pcm_s8',1],['pcm_s16le',2],['pcm_s24le',3],['pcm_s32le',0x40004],['pcm_f32le',4],['pcm_f64le',8]];
const refusal=(exitCode:number)=>expect.objectContaining({code:'unsupported-command',exitCode});
it('parses all seven IRCAM magics with their field endianness and both tag tables',async()=>{
  for(const [magic,le]of magics)for(const [codec,tag]of leTags){
    const bytes=fixture(magic,le,{rate:22050,channels:2,tag},[...Array(48).keys()]),requests:Array<{offset:bigint;length:number}>=[];
    const input=await openIrcam(memoryInput(bytes,requests),{maxReadBytes:64}),expected=le||['pcm_alaw','pcm_mulaw','pcm_s8'].includes(codec)?codec:codec.replace('le','be');
    const width=({pcm_s16le:2,pcm_s24le:3,pcm_s32le:4,pcm_f32le:4,pcm_f64le:8} as Record<string,number>)[codec]??1;
    expect(input.info).toMatchObject({container:'ircam',codec:expected,channels:2,sampleRate:22050,channelMask:null,dataOffset:1024n,littleEndian:le,magic,blockAlign:2*width,durationSamples:BigInt(48/(2*width))});
    expect(requests[0]).toEqual({offset:0n,length:16});
  }
  const requests:Array<{offset:bigint;length:number}>=[],mono=await openIrcam(memoryInput(fixture(0x0002a364,false,{tag:1},[5,6,7]),requests),{maxReadBytes:1});
  expect(mono.info).toMatchObject({codec:'pcm_s8',durationSamples:3n});expect(requests).toEqual([...Array(16).keys()].map(offset=>({offset:BigInt(offset),length:1})));
  const packets=[];for await(const packet of mono.packets(1n))packets.push([packet.pts,[...packet.data]]);expect(packets).toEqual([[1n,[6]],[2n,[7]]]);
});
it('rounds the float rate with lrintf semantics and refuses platform-dependent rates',async()=>{
  expect([22050.5,22051.5,0.5,1.5,2.5,-0.5,-1.5,7999.75,1e-30,2147483520].map(ircamRate)).toEqual([22050,22052,0,2,2,0,-2,8000,0,2147483520]);
  expect([Infinity,-Infinity,NaN,2147483648,-2147483904].map(ircamRate)).toEqual([null,null,null,null,null]);
  expect(Object.is(ircamRate(-0.25),0)).toBe(true);
  for(const rateBits of [0x7fc00000,0x7f800000,float(2147483648),float(1e20)])await expect(openIrcam(memoryInput(fixture(0x0001a364,true,{rateBits})),{maxReadBytes:64})).rejects.toThrow('platform dependent');
  expect((await openIrcam(memoryInput(fixture(0x0001a364,true,{rate:22050.5})),{maxReadBytes:64})).info.sampleRate).toBe(22050);
  expect((await openIrcam(memoryInput(fixture(0x64a30100,false,{rate:22051.5})),{maxReadBytes:64})).info.sampleRate).toBe(22052);
});
it('refuses IRCAM headers with native exit statuses in native order',async()=>{
  const open=(bytes:Uint8Array)=>openIrcam(memoryInput(bytes),{maxReadBytes:2048});
  await expect(open(fixture(0x0004a364,true))).rejects.toEqual(refusal(183));
  await expect(open(fixture(0x0001a364,true,{channels:0}))).rejects.toEqual(refusal(183));
  await expect(open(fixture(0x0001a364,true,{rate:0.5}))).rejects.toEqual(refusal(183));
  await expect(open(fixture(0x0001a364,true,{rate:0,channels:513}))).rejects.toEqual(refusal(183));
  await expect(open(fixture(0x0001a364,true,{channels:513}))).rejects.toEqual(refusal(218));
  await expect(open(fixture(0x0001a364,true,{channels:513,tag:5}))).rejects.toEqual(refusal(218));
  await expect(open(fixture(0x0001a364,true,{tag:5}))).rejects.toThrow('unknown tag 5');
  await expect(open(fixture(0x0001a364,true,{tag:0x10002}))).rejects.toEqual(refusal(183));
  await expect(open(fixture(0x0001a364,true,{channels:0x80000000}))).rejects.toThrow('2^31');
  await expect(open(fixture(0x0001a364,true,{rate:-8000}))).rejects.toThrow('Negative');
  await expect(open(new Uint8Array([0x64,0xa3,1,0]))).rejects.toEqual(refusal(183));
  const header=fixture(0x0001a364,true,{channels:512},[]);expect((await open(header.subarray(0,16))).info).toMatchObject({channels:512,durationSamples:0n});
  await expect(open(fixture(0x0001a364,true,{channels:2},[1,2,3]))).rejects.toThrow('Incomplete');
  await expect(openIrcam(memoryInput(fixture(0x0001a364,true)),{maxReadBytes:0})).rejects.toThrow('read budget');
});
it('probes native IRCAM heads, confirms the second form with bounded reads and never detects by extension',async()=>{
  for(const [magic,le]of magics){
    const bytes=fixture(magic,le),detectable=(magic&0xffff)===0xa364||magic!==0x64a30400;
    if(detectable)expect(await detectAudioContainer(memoryInput(bytes),3)).toBe('ircam');else await expect(detectAudioContainer(memoryInput(bytes),3)).rejects.toThrow('signature');
    if(!detectable)await expect(detectAudioContainer(memoryInput(bytes),3,undefined,'/x.sf')).rejects.toThrow('signature');
  }
  expect(ircam.demux.probe.head(new Uint8Array([0x64,0xa3,4,0]))).toBe(true);
  for(const head of [[0x64,0xa3,0,0],[0x64,0xa3,5,0],[0,4,0xa3,0x64],[0,1,0xa3,0x65]])expect(ircam.demux.probe.head(new Uint8Array(head))).toBe(false);
  const zeroRate=fixture(0x64a30100,false,{rateBits:0}),requests:Array<{offset:bigint;length:number}>=[];
  await expect(detectAudioContainer(memoryInput(zeroRate,requests),5)).rejects.toThrow('signature');
  expect(requests.every(request=>request.length<=5&&request.offset<12n)).toBe(true);
  expect(await detectAudioContainer(memoryInput(fixture(0x0001a364,true,{rateBits:0})),5)).toBe('ircam');
  await expect(detectAudioContainer(memoryInput(zeroRate),5,undefined,'/a.ircam')).rejects.toThrow('signature');
  expect(await ircam.demux.probe.confirm!(memoryInput(new Uint8Array([0,1,0xa3,0x64,1,0,0,0])),64,undefined)).toBe(false);
});
it('ports av_q2intfloat for IRCAM output rates and writes the 1024-byte little-endian header',async()=>{
  expect([1,8000,22050,44100,96000,16777216,16777217,16777219,33554431,2147483647].map(ircamRateBits)).toEqual([0x3f800000,0x45fa0000,0x46ac4400,0x472c4400,0x47bb8000,0x4b800000,0x4b800001,0x4b800002,0x4c000000,0x4f000000]);
  expect(()=>ircamRateBits(0)).toThrow('rate');
  for(const [codec,tag]of leTags){
    const sink=collectingOutput();async function* packets():AsyncIterable<MediaPacket>{}
    await muxIrcam(sink.output,{codec:codec as never,channels:5,sampleRate:44100},packets(),{sampleCount:0n,maxWriteBytes:100});
    const bytes=sink.bytes(),view=new DataView(bytes.buffer);
    expect([view.getUint32(0,true),view.getUint32(4,true),view.getUint32(8,true),view.getUint32(12,true)]).toEqual([0x0001a364,0x472c4400,5,tag]);
    expect(bytes.length).toBe(1024);expect(bytes.subarray(16).every(byte=>byte===0)).toBe(true);expect(sink.lengths.every(length=>length<=100)).toBe(true);expect(sink.committed).toBe(true);
  }
  for(const codec of ['pcm_s16be','pcm_u8','pcm_u16le','pcm_f32be','pcm_s24be'])expect(()=>validateIrcamOutput({codec:codec as never,channels:1,sampleRate:8000},0n)).toThrow(expect.objectContaining({exitCode:234,message:`IRCAM muxer does not support ${codec}`}));
});
it('aborts IRCAM output exactly once and honors cancellation',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));await expect(openIrcam(memoryInput(fixture(0x0001a364,true)),{maxReadBytes:8,signal:controller.signal})).rejects.toThrow('stop');
  const sink=collectingOutput();let aborted=0;async function* packets():AsyncIterable<MediaPacket>{yield {streamIndex:0,data:new Uint8Array([1,2]),pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:8000n},flags:1};}
  await expect(muxIrcam({...sink.output,async abort(reason){aborted++;await sink.output.abort(reason);}},{codec:'pcm_s16le',channels:1,sampleRate:8000},packets(),{sampleCount:2n,maxWriteBytes:7})).rejects.toThrow();expect(aborted).toBe(1);expect(sink.committed).toBe(false);
  const refused=collectingOutput();let refusedAborts=0;
  await expect(muxIrcam({...refused.output,async abort(reason){refusedAborts++;await refused.output.abort(reason);}},{codec:'pcm_s16be' as never,channels:1,sampleRate:8000},packets(),{sampleCount:1n,maxWriteBytes:7})).rejects.toThrow('does not support');expect(refusedAborts).toBe(1);expect(refused.lengths).toEqual([]);
  const halted=new AbortController(),late=collectingOutput();halted.abort(new Error('halt'));
  await expect(muxIrcam(late.output,{codec:'pcm_s16le',channels:1,sampleRate:8000},packets(),{sampleCount:1n,maxWriteBytes:7,signal:halted.signal})).rejects.toThrow('halt');expect(late.aborted).toBe(true);
});
it('registers the IRCAM descriptor with native names, extensions, codecs and packet span',()=>{
  expect(containerFormat('ircam')).toBe(ircam);
  expect(ircam.demux).toMatchObject({headerBytes:16,probe:{precedence:100}});expect('extensions' in ircam.demux).toBe(false);
  expect(ircam.mux).toMatchObject({label:'IRCAM',extensions:['.sf','.ircam'],defaultCodec:'pcm_s16le',scratchBytes:1024,dropsMetadata:true});
  expect(leTags.every(([codec])=>supportsIrcamCodec(codec)&&ircam.mux.supports(codec as never))).toBe(true);
  expect(['pcm_s16be','pcm_u8','pcm_u16le','pcm_s32be','pcm_f64be'].some(codec=>supportsIrcamCodec(codec))).toBe(false);
  expect(ircam.mux.refuse!('pcm_u8')).toMatchObject({code:'unsupported-command',exitCode:234});
  expect([[8000,2],[22050,4],[44100,1],[9,1],[96000,4096],[2147483647,4096],[2147483647,1]].map(([sampleRate,blockAlign])=>ircamPacketSpan({sampleRate:sampleRate!,blockAlign:blockAlign!}))).toEqual([512n,2048n,4096n,1n,8192n,262144n,134217728n]);
  expect(Object.isFrozen(ircam)&&Object.isFrozen(ircam.demux)&&Object.isFrozen(ircam.mux)).toBe(true);
});
