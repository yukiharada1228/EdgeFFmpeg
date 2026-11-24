import {expect,it} from 'vitest';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import {ExecutionError} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {avr,avrPcmCodec,openAvr,AvrError} from '../../packages/containers/src/avr.js';
import {memoryInput} from '../helpers/wav.js';
function header(chan:number,bps:number,sign:number,rate:number,payload:number[]=[]):Uint8Array{
  const bytes=new Uint8Array(128+payload.length),view=new DataView(bytes.buffer);bytes.set([0x32,0x42,0x49,0x54]);
  view.setUint16(12,chan,false);view.setUint16(14,bps,false);view.setUint16(16,sign,false);view.setUint16(18,0xffff,false);bytes[22]=0xff;bytes.set([rate>>16&255,rate>>8&255,rate&255],23);bytes.fill(0xee,26,128);bytes.set(payload,128);
  return bytes;
}
async function collect(input:Awaited<ReturnType<typeof openAvr>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
it('ports ff_get_pcm_codec_id for big-endian integer PCM with per-width sign masks',()=>{
  for(const [bps,s,u] of [[8,'pcm_s8','pcm_u8'],[16,'pcm_s16be','pcm_u16be'],[24,'pcm_s24be','pcm_u24be'],[32,'pcm_s32be','pcm_u32be']] as const){
    const bit=1<<(bps/8-1);expect([avrPcmCodec(bps,0xffff),avrPcmCodec(bps,bit),avrPcmCodec(bps,0),avrPcmCodec(bps,0xffff^bit)]).toEqual([s,s,u,u]);
  }
  // Native AV_CODEC_ID_NONE.
  for(const [bps,sign] of [[0,0xffff],[65,0xffff],[40,0xffff],[40,0],[64,0],[56,0xffff]] as const)expect(avrPcmCodec(bps,sign),`${bps}/${sign}`).toBe('unmapped');
  // Native codecs left unported: bps rounded up to whole bytes, and pcm_s64be.
  for(const [bps,sign] of [[12,0xffff],[12,0],[4,0],[1,1],[31,0],[64,0xffff]] as const)expect(avrPcmCodec(bps,sign),`${bps}/${sign}`).toBeNull();
});
it('parses the 128-byte AVR header with bounded reads and serves PCM packets from offset 128',async()=>{
  const requests:Array<{offset:bigint;length:number}>=[],bytes=header(0xffff,16,0xffff,0x017700,[1,2,3,4,5,6,7,8,9,10,11,12]),input=await openAvr(memoryInput(bytes,requests),{maxReadBytes:5});
  expect(input.info).toMatchObject({container:'avr',codec:'pcm_s16be',channels:2,sampleRate:96000,channelMask:null,bitsPerSample:16,blockAlign:4,dataOffset:128n,dataBytes:12n,durationSamples:3n,sign:0xffff});
  expect(requests.every(request=>request.length<=5&&request.offset<128n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(128);
  requests.length=0;const packets=await collect(input,1n,4);
  expect(packets.map(packet=>[packet.pts,packet.duration,[...packet.data]])).toEqual([[1n,1n,[5,6,7,8]],[2n,1n,[9,10,11,12]]]);expect(requests.every(request=>request.offset>=132n)).toBe(true);
  const mono=await openAvr(memoryInput(header(0,24,0,8000,[1,2,3])),{maxReadBytes:128});expect(mono.info).toMatchObject({codec:'pcm_u24be',channels:1,blockAlign:3,durationSamples:1n,sampleRate:8000});
  expect((await openAvr(memoryInput(header(0,8,0xfffe,22050)),{maxReadBytes:128})).info).toMatchObject({codec:'pcm_u8',durationSamples:0n});
});
it('refuses AVR headers in native order with native exit statuses and unported layouts explicitly',async()=>{
  const status=async(bytes:Uint8Array)=>{try{await openAvr(memoryInput(bytes),{maxReadBytes:128});}catch(error){return error;}throw new Error('opened');};
  for(const [bytes,code,message] of [[header(2,0,0,0),176,'chan 2'],[header(0x100,16,0xffff,8000),176,'chan 256'],[header(0,0,0,0),183,'sample rate'],[header(0,40,0xffff,8000),176,'bps 40'],[header(0xffff,64,0,8000),176,'bps 64']] as const){
    const error=await status(bytes);expect(error).toBeInstanceOf(ExecutionError);expect(error).toMatchObject({code:'unsupported-command',exitCode:code});expect((error as Error).message).toContain(message);
  }
  for(const [bytes,message] of [[header(0,12,0xffff,8000,[0,0]),'bps 12'],[header(0,64,0xffff,8000),'bps 64'],[header(0xffff,16,0xffff,8000,[1,2,3,4,5,6]),'partial trailing'],[header(0,16,0xffff,8000,[1]),'partial trailing'],[header(0,16,0xffff,8000).subarray(0,127),'Truncated']] as const){
    const error=await status(bytes);expect(error).toBeInstanceOf(AvrError);expect((error as Error).message).toContain(message);
  }
  const wrong=header(0,16,0xffff,8000);wrong[0]=0x33;await expect(openAvr(memoryInput(wrong),{maxReadBytes:128})).rejects.toThrow('signature');
  await expect(openAvr(memoryInput(header(0,16,0xffff,8000)),{maxReadBytes:0})).rejects.toThrow('budget');
});
it('aborts AVR opens and packet reads on the signal',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(openAvr(memoryInput(header(0,16,0xffff,8000,[1,2])),{maxReadBytes:128,signal:controller.signal})).rejects.toThrow('stop');
  const live=new AbortController(),bytes=header(0,8,1,8000,[1,2,3,4]);let reads=0;
  const input=await openAvr({size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===3)live.abort(new Error('halt'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}},{maxReadBytes:64,signal:live.signal});
  await expect(collect(input,0n,1)).rejects.toThrow('halt');
  const midHeader=new AbortController();
  await expect(openAvr({size:BigInt(bytes.length),async readAt(offset,length){midHeader.abort(new Error('mid'));return bytes.slice(Number(offset),Number(offset)+length);}},{maxReadBytes:16,signal:midHeader.signal})).rejects.toThrow('mid');
});
it('registers a demux-only avr descriptor detected by the 2BIT magic',async()=>{
  expect(containerFormat('avr')).toBe(avr);expect(avr.name).toBe('avr');expect('mux' in avr).toBe(false);
  expect(avr.demux.headerBytes).toBe(128);expect(avr.demux.probe.precedence).toBe(100);expect('confirm' in avr.demux.probe).toBe(false);expect(Object.isFrozen(avr)&&Object.isFrozen(avr.demux)&&Object.isFrozen(avr.demux.probe)).toBe(true);
  expect(avr.demux.probe.head(Uint8Array.from([0x32,0x42,0x49,0x54]))).toBe(true);expect(avr.demux.probe.head(Uint8Array.from([0x32,0x42,0x49,0x55]))).toBe(false);
  const requests:Array<{offset:bigint;length:number}>=[];expect(await detectAudioContainer(memoryInput(header(0xffff,16,0xffff,8000,[0,0,0,0]),requests),64)).toBe('avr');expect(requests.every(request=>request.offset===0n&&request.length<=4)).toBe(true);
  const opened=await avr.demux.open(memoryInput(header(0,16,2,44100,[0,1])),{maxReadBytes:64,signal:new AbortController().signal,declared:{channels:1,sampleRate:44100,guessLayout:true},seek:0n});
  expect(opened.info).toMatchObject({codec:'pcm_s16be',channels:1,sampleRate:44100,durationSamples:1n});
});
