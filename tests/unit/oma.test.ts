import {expect,it} from 'vitest';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import {ExecutionError} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {isEa3Tag,isOmaHeader,oma,openOma,probeOma,OmaError} from '../../packages/containers/src/oma.js';
import {memoryInput} from '../helpers/wav.js';
/** A 96-byte EA3 header (eid at 6, codec id at 32) followed by the payload. */
function header(payload:number[]|number=[],codecId=4,eid=0xffff):Uint8Array{
  const data=typeof payload==='number'?Array.from({length:payload},(_,index)=>index*7&255):payload,bytes=new Uint8Array(96+data.length),view=new DataView(bytes.buffer);
  bytes.set([0x45,0x41,0x33,0x01,0,96]);view.setUint16(6,eid,false);bytes.fill(0xcc,8,32);bytes[32]=codecId;bytes.set([0x12,0x34,0x56],33);bytes.fill(0xdd,36,96);bytes.set(data,96);
  return bytes;
}
async function collect(input:Awaited<ReturnType<typeof openOma>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
async function failure(bytes:Uint8Array):Promise<unknown>{try{await openOma(memoryInput(bytes),{maxReadBytes:96});}catch(error){return error;}throw new Error('opened');}
it('parses the 96-byte EA3 header with bounded reads and serves stereo 44100 Hz s16be from offset 96',async()=>{
  const requests:Array<{offset:bigint;length:number}>=[],bytes=header([1,2,3,4,5,6,7,8,9,10,11,12]),input=await openOma(memoryInput(bytes,requests),{maxReadBytes:7});
  expect(input.info).toMatchObject({container:'oma',codec:'pcm_s16be',channels:2,sampleRate:44100,channelMask:null,blockAlign:4,dataOffset:96n,dataBytes:12n,durationSamples:3n,eid:0xffff});
  expect(input.info.copyRefusal).toContain('short final packet');
  expect(requests.every(request=>request.length<=7&&request.offset<96n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(96);
  requests.length=0;const packets=await collect(input,1n,4);
  expect(packets.map(packet=>[packet.pts,packet.duration,[...packet.data]])).toEqual([[1n,1n,[5,6,7,8]],[2n,1n,[9,10,11,12]]]);expect(requests.every(request=>request.offset>=100n)).toBe(true);
  // The eid 0xFF80 (-128) is unencrypted too; whole 1024-byte packets copy, and an empty payload is zero packets.
  const whole=await openOma(memoryInput(header(2048,4,0xff80)),{maxReadBytes:96});expect(whole.info).toMatchObject({eid:0xff80,durationSamples:512n});expect('copyRefusal' in whole.info).toBe(false);
  const empty=await openOma(memoryInput(header()),{maxReadBytes:96});expect(empty.info.durationSamples).toBe(0n);expect('copyRefusal' in empty.info).toBe(false);expect(await collect(empty)).toEqual([]);
  expect((await openOma(memoryInput(header(1028)),{maxReadBytes:96})).info.copyRefusal).toBeDefined();
});
it('refuses OMA headers in native order with native statuses and unported codecs, tags and partial frames explicitly',async()=>{
  const bad=header(8);bad[5]=95;const lower=header(8);lower[4]=1;const magic=header(8);magic[2]=0x34;
  for(const [bytes,code,message] of [[header(8).subarray(0,95),255,'Truncated'],[bad,183,'EA3 header'],[lower,183,'EA3 header'],[magic,183,'EA3 header'],
    [header(8,4,0),255,'encrypted'],[header(8,4,0xff7f),255,'encrypted'],[header(8,4,0x7fff),255,'encrypted'],[header(8,5),218,'codec 5'],[header(8,99),218,'codec 99'],[header(8,255),218,'codec 255']] as const){
    const error=await failure(bytes);expect(error,message).toBeInstanceOf(ExecutionError);expect(error).toMatchObject({code:'unsupported-command',exitCode:code});expect((error as Error).message).toContain(message);
  }
  const tag=Uint8Array.from([0x65,0x61,0x33,3,0,0,0,0,0,10,...header(8)]);
  for(const [bytes,message] of [[header(8,0),'ATRAC3 (atrac3)'],[header(8,1),'atrac3p'],[header(8,2),'aac'],[header(8,3),'mp3'],[header(8,33),'atrac3pal'],[header(8,34),'atrac3al'],[header(6),'partial trailing'],[header(1),'partial trailing'],[tag,'ea3 tag']] as const){
    const error=await failure(bytes);expect(error,message).toBeInstanceOf(OmaError);expect((error as Error).message).toContain(message);
  }
  // A short ea3 tag is refused before the truncation status; an EA3 header after ID3 framing bytes that do not match is native INVALIDDATA.
  expect(await failure(tag.subarray(0,40))).toBeInstanceOf(OmaError);
  const unmatched=tag.slice();unmatched[3]=0xff;expect(await failure(unmatched)).toMatchObject({exitCode:183});
  await expect(openOma(memoryInput(header(4)),{maxReadBytes:0})).rejects.toThrow('budget');
});
it('ports oma_read_probe and ff_id3v2_match over the bytes native inspects',async()=>{
  expect(isOmaHeader(Uint8Array.from([0x45,0x41,0x33,0x99,0,96]))).toBe(true);
  for(const bytes of [[0x45,0x41,0x33,0,1,96],[0x45,0x41,0x33,0,0,97],[0x65,0x61,0x33,0,0,96],[0x45,0x41,0x33,0,0]])expect(isOmaHeader(Uint8Array.from(bytes)),bytes.join()).toBe(false);
  expect(isEa3Tag(Uint8Array.from([0x65,0x61,0x33,3,0,0,0,0,0,0]))).toBe(true);
  for(const bytes of [[0x65,0x61,0x33,0xff,0,0,0,0,0,0],[0x65,0x61,0x33,3,0xff,0,0,0,0,0],[0x65,0x61,0x33,3,0,0,0x80,0,0,0],[0x65,0x61,0x33,3,0,0,0,0,0,0x80],[0x49,0x44,0x33,3,0,0,0,0,0,0],[0x65,0x61,0x33,3,0,0,0,0,0]])expect(isEa3Tag(Uint8Array.from(bytes)),bytes.join()).toBe(false);
  const requests:Array<{offset:bigint;length:number}>=[];expect(await probeOma(memoryInput(header(4),requests),2)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(6);expect(requests.every(request=>request.length<=2)).toBe(true);
  expect(await probeOma(memoryInput(header().subarray(0,5)),64)).toBe(false);await expect(probeOma(memoryInput(header()),0)).rejects.toThrow('budget');
});
it('aborts OMA opens and packet reads on the signal',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(openOma(memoryInput(header(8)),{maxReadBytes:96,signal:controller.signal})).rejects.toThrow('stop');
  const live=new AbortController(),bytes=header(16);let reads=0;
  const input=await openOma({size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===3)live.abort(new Error('halt'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}},{maxReadBytes:96,signal:live.signal});
  await expect(collect(input,0n,4)).rejects.toThrow('halt');
  const midHeader=new AbortController();
  await expect(openOma({size:BigInt(bytes.length),async readAt(offset,length){midHeader.abort(new Error('mid'));return bytes.slice(Number(offset),Number(offset)+length);}},{maxReadBytes:16,signal:midHeader.signal})).rejects.toThrow('mid');
});
it('registers a demux-only oma descriptor detected by EA3 with a six-byte confirm, 256-sample packets and an input-seek refusal',async()=>{
  expect(containerFormat('oma')).toBe(oma);expect(oma.name).toBe('oma');expect('mux' in oma).toBe(false);expect('extensions' in oma.demux).toBe(false);
  expect(oma.demux.headerBytes).toBe(96);expect(oma.demux.probe.precedence).toBe(100);expect(Object.isFrozen(oma)&&Object.isFrozen(oma.demux)&&Object.isFrozen(oma.demux.probe)).toBe(true);
  expect(oma.demux.probe.head(Uint8Array.from([0x45,0x41,0x33,0]))).toBe(true);expect(oma.demux.probe.head(Uint8Array.from([0x65,0x61,0x33,3]))).toBe(false);
  const requests:Array<{offset:bigint;length:number}>=[];expect(await detectAudioContainer(memoryInput(header(4),requests),64)).toBe('oma');expect(requests.every(request=>request.offset===0n)).toBe(true);expect(Math.max(...requests.map(request=>request.length))).toBeLessThanOrEqual(6);
  const declared={channels:1,sampleRate:8000,guessLayout:true},signal=new AbortController().signal;
  const opened=await oma.demux.open(memoryInput(header(1024)),{maxReadBytes:64,signal,declared,seek:0n});
  expect(opened.info).toMatchObject({codec:'pcm_s16be',channels:2,sampleRate:44100,durationSamples:256n});expect(oma.demux.packetSpan(opened.info)).toBe(256n);
  await expect(oma.demux.open(memoryInput(header(1024)),{maxReadBytes:64,signal,declared,seek:1n})).rejects.toMatchObject({code:'unsupported-command',message:'OMA input seeking is not implemented'});
});
