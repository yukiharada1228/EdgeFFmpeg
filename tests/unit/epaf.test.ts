import {describe,expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {epaf,openEpaf,probeEpaf} from '../../packages/containers/src/epaf.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
// Header layout from libavformat/epafdec.c: magic, zero word, LE flag (always little-endian), rate, codec, channels, data at 2048.
function paf(options:{le?:boolean;codec?:number;channels?:number;rate?:number;word4?:number;flag?:number;magic?:string}={},payload=new Uint8Array(0)):Uint8Array{
  const {le=true,codec=0,channels=2,rate=8000,word4=0}=options,bytes=new Uint8Array(2048+payload.length),view=new DataView(bytes.buffer);
  bytes.set([...(options.magic??(le?'fap ':' paf'))].map(c=>c.charCodeAt(0)));view.setUint32(4,word4,true);view.setUint32(8,options.flag??(le?1:0),true);
  view.setInt32(12,rate,le);view.setInt32(16,codec,le);view.setInt32(20,channels,le);bytes.set(payload,2048);return bytes;
}
async function collect(input:Awaited<ReturnType<typeof openEpaf>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
async function run(input:Uint8Array,args:readonly string[]){
  const sink=collectingOutput();let opens=0;
  const filesystem:VirtualFileSystem={async openRead(){return memoryInput(input);},async openWrite(){opens++;return sink.output;}};
  const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args);
  return {result,opens,bytes:sink.bytes(),last:result.diagnostics.at(-1)};
}
describe('epaf demuxer',()=>{
  it('parses LE and BE headers with bounded reads and never reads the 2024 skipped bytes or payload while opening',async()=>{
    const pcm=Uint8Array.from([1,2,3,4,5,6,7,8]);
    for(const [le,codec,expected,align] of [[true,0,'pcm_s16le',4],[false,0,'pcm_s16be',4],[true,2,'pcm_s8',2],[false,2,'pcm_s8',2]] as const){
      const requests:Array<{offset:bigint;length:number}>=[],input=await openEpaf(memoryInput(paf({le,codec,rate:44100},pcm),requests),{maxReadBytes:5});
      expect(input.info).toMatchObject({container:'epaf',littleEndian:le,codec:expected,channels:2,sampleRate:44100,channelMask:null,blockAlign:align,dataOffset:2048n,dataBytes:8n,durationSamples:BigInt(8/align)});
      expect(requests.every(request=>request.length<=5&&request.offset+BigInt(request.length)<=24n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(24);
      requests.length=0;const packets=await collect(input,1n,align);
      expect(packets.map(packet=>[packet.pts,packet.duration])).toEqual(Array.from({length:8/align-1},(_,index)=>[BigInt(index+1),1n]));
      expect(requests.every(request=>request.offset>=2048n+BigInt(align))).toBe(true);
    }
    expect((await openEpaf(memoryInput(paf({channels:512})),{maxReadBytes:1024})).info).toMatchObject({channels:512,durationSamples:0n});
  });
  it('mirrors epaf_probe over exactly 24 bytes',async()=>{
    expect(probeEpaf(paf())).toBe(true);expect(probeEpaf(paf({le:false}))).toBe(true);
    expect(probeEpaf(paf({flag:0}))).toBe(false);expect(probeEpaf(paf({le:false,flag:1}))).toBe(false);
    expect(probeEpaf(paf({word4:1}))).toBe(false);expect(probeEpaf(paf({rate:0}))).toBe(false);expect(probeEpaf(paf({channels:0}))).toBe(false);
    // The codec word is not inspected, so probing accepts codec 1 and read_header refuses it.
    expect(probeEpaf(paf({codec:1}))).toBe(true);expect(probeEpaf(paf().subarray(0,23))).toBe(false);
    const requests:Array<{offset:bigint;length:number}>=[];expect(await detectAudioContainer(memoryInput(paf(),requests),64)).toBe('epaf');
    expect(requests).toEqual([{offset:0n,length:4},{offset:0n,length:24}]);
    expect(await detectAudioContainer(memoryInput(paf({le:false}).subarray(0,2048)),3)).toBe('epaf');
    await expect(detectAudioContainer(memoryInput(paf({flag:0})),64)).rejects.toThrow(/^Unsupported audio container signature$/);
    await expect(detectAudioContainer(memoryInput(paf().subarray(0,20)),64)).rejects.toThrow(/^Unsupported audio container signature$/);
  });
  it('refuses invalid fields and short headers with native INVALIDDATA status and partial frames explicitly',async()=>{
    const status=(promise:Promise<unknown>)=>promise.then(()=>null,(error:Error&{code?:string;exitCode?:number})=>[error.code,error.exitCode,error.message]);
    const open=(bytes:Uint8Array)=>status(openEpaf(memoryInput(bytes),{maxReadBytes:4096}));
    expect(await open(paf({codec:1}))).toEqual(['unsupported-command',183,'24-bit Paris PCM format is not supported']);
    expect(await open(paf({codec:3}))).toEqual(['unsupported-command',183,'Unsupported EPAF codec: 3']);
    expect(await open(paf({codec:-1,le:false}))).toEqual(['unsupported-command',183,'Unsupported EPAF codec: -1']);
    for(const fields of [{channels:0},{channels:513},{channels:-2},{rate:-8000},{rate:0}])expect(await open(paf(fields))).toEqual(['unsupported-command',183,'Invalid EPAF channels or sample rate']);
    expect(await open(paf({word4:1}))).toEqual(['unsupported-command',183,'Invalid EPAF header word']);
    expect(await open(paf({flag:2}))).toEqual(['unsupported-command',183,'Invalid EPAF byte order']);
    // Native fails its 2024-byte skip past EOF, so every file shorter than the data offset is INVALIDDATA before any field is trusted.
    for(const length of [0,23,24,2047])expect(await open(paf({codec:1}).subarray(0,length))).toEqual(['unsupported-command',183,'Truncated EPAF header']);
    expect(await open(paf({},new Uint8Array(5)))).toEqual(['unsupported',undefined,'Partial trailing EPAF sample frame is not implemented']);
    expect(await open(paf({codec:2,channels:3},new Uint8Array(7)))).toEqual(['unsupported',undefined,'Partial trailing EPAF sample frame is not implemented']);
    await expect(openEpaf(memoryInput(paf()),{maxReadBytes:0})).rejects.toThrow('Invalid EPAF read budget');
    // 512 s16 channels need a 1024-byte frame per read.
    await expect(openEpaf(memoryInput(paf({channels:512})),{maxReadBytes:1023})).rejects.toThrow('read budget');
  });
  it('honours abort before and between bounded header reads',async()=>{
    const aborted=new AbortController();aborted.abort(new Error('stop'));
    await expect(openEpaf(memoryInput(paf()),{maxReadBytes:4,signal:aborted.signal})).rejects.toThrow('stop');
    const controller=new AbortController(),bytes=paf();let reads=0;
    const input={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){if(++reads===2)controller.abort(new Error('mid'));return bytes.slice(Number(offset),Number(offset)+length);}};
    await expect(openEpaf(input,{maxReadBytes:4,signal:controller.signal})).rejects.toThrow('mid');expect(reads).toBe(2);
  });
  it('registers a demux-only descriptor with an exact probe',()=>{
    const descriptor=containerFormat('epaf')!;expect(descriptor).toBe(epaf);expect(descriptor.mux).toBeUndefined();expect(descriptor.headerless).toBeUndefined();
    expect(descriptor.demux).toMatchObject({headerBytes:24,probe:{precedence:100}});expect(descriptor.demux?.packetSpan).toBeUndefined();expect(descriptor.demux?.seekBeyondEnd).toBeUndefined();expect(descriptor.demux?.extensions).toBeUndefined();
    expect(containerProbes).toContain(epaf);
    const head=(text:string)=>epaf.demux.probe!.head(Uint8Array.from([...text].map(c=>c.charCodeAt(0))));
    expect([head('fap '),head(' paf'),head('FAP '),head('paf '),head('RIFF')]).toEqual([true,true,false,false,false]);
  });
  it('decodes through the media backend and refuses before any output exists',async()=>{
    const pcm=new Uint8Array(40);for(let index=0;index<40;index++)pcm[index]=index*7;
    const reference=await run(pcm,['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','/out.wav']);
    const detected=await run(paf({},pcm),['-i','/in.paf','/out.wav']);expect(detected.result.exitCode,JSON.stringify(detected.result.diagnostics)).toBe(0);expect(detected.bytes).toEqual(reference.bytes);
    const swapped=Uint8Array.from(pcm,(_,index)=>pcm[index^1]!),big=await run(paf({le:false},swapped),['-f','epaf','-i','/in.paf','/out.wav']);expect(big.bytes).toEqual(reference.bytes);
    const codec=await run(paf({codec:1},pcm),['-i','/in.paf','/out.wav']);expect([codec.result.exitCode,codec.opens]).toEqual([183,0]);
    const partial=await run(paf({},pcm.subarray(0,39)),['-i','/in.paf','/out.wav']);expect(partial.result.exitCode).not.toBe(0);expect(partial.opens).toBe(0);
    const declared=await run(paf({},pcm),['-f','epaf','-ar','8000','-i','/in.paf','/out.wav']);expect([declared.last?.message,declared.opens]).toEqual(['Input rate/channel declarations currently require a raw PCM format',0]);
    const output=await run(pcm,['-f','s16le','-i','/in.raw','-f','epaf','/out.paf']);expect(output.opens).toBe(0);expect(output.result.exitCode).not.toBe(0);
  });
});
