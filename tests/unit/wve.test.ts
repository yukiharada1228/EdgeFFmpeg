import {expect,it} from 'vitest';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {openWve,probeWve,matchesWve,wve as descriptor} from '../../packages/containers/src/wve.js';
import {memoryInput} from '../helpers/wav.js';
// Header bytes as listed in libavformat/wvedec.c wve_probe, independent of the module's tables.
function wve(dataBytes:number,duration:number):Uint8Array{
  const bytes=new Uint8Array(32+dataBytes),view=new DataView(bytes.buffer);bytes.set([...'ALawSoundFile**'].map(c=>c.charCodeAt(0)));bytes.set([0,0o17,0o20],15);view.setUint32(18,duration,false);bytes[25]=1;
  for(let i=0;i<dataBytes;i++)bytes[32+i]=i&255;return bytes;
}
async function collect(input:Awaited<ReturnType<typeof openWve>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
it('parses the WVE header as A-law mono 8000 Hz with data from byte 32 to EOF and an informational duration',async()=>{
  for(const [length,duration]of [[0,0],[1,1],[3000,100],[513,0],[8001,0xfffffffe]] as const){
    const input=await openWve(memoryInput(wve(length,duration)),{maxReadBytes:64});
    expect(input.info).toMatchObject({container:'wve',codec:'pcm_alaw',channels:1,sampleRate:8000,channelMask:null,blockAlign:1,bitsPerSample:8,dataOffset:32n,dataBytes:BigInt(length),durationSamples:BigInt(length),headerDuration:BigInt(duration)});
    const packets=await collect(input,0n,64);expect(packets.reduce((sum,packet)=>sum+packet.data.length,0)).toBe(length);if(length)expect(packets[0]!.data[1]??1).toBe(1);
  }
  // wve_read_header never checks the magic: a forced -f wve header with other bytes still opens.
  const altered=wve(4,4);altered[0]=0;altered[23]=9;expect((await openWve(memoryInput(altered),{maxReadBytes:64})).info.durationSamples).toBe(4n);
});
it('reads only the 32 header bytes within a 64-byte budget and the requested data range afterwards',async()=>{
  for(const maxReadBytes of [64,7,1]){
    const requests:Array<{offset:bigint;length:number}>=[],input=await openWve(memoryInput(wve(3000,3000),requests),{maxReadBytes});
    expect(requests.every(request=>request.length<=maxReadBytes&&request.offset+BigInt(request.length)<=32n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(32);
    requests.length=0;const packets=await collect(input,2990n,maxReadBytes);expect(packets.map(packet=>packet.pts)[0]).toBe(2990n);expect(requests.every(request=>request.offset>=3022n&&request.length<=maxReadBytes)).toBe(true);
  }
});
it('probes the 18-byte magic and bytes 22 to 31 like wve_probe with at most 32 bytes read',async()=>{
  const valid=wve(600,600),requests:Array<{offset:bigint;length:number}>=[];
  expect(await probeWve(memoryInput(valid,requests),64)).toBe(true);expect(requests).toEqual([{offset:0n,length:32}]);
  requests.length=0;expect(await detectAudioContainer(memoryInput(valid,requests),64)).toBe('wve');expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(36);
  for(const index of [4,14,15,16,17,22,23,24,25,26,31]){const bytes=valid.slice();bytes[index]=((bytes[index]??0)^1);expect(matchesWve(bytes),String(index)).toBe(false);expect(await probeWve(memoryInput(bytes),64)).toBe(false);await expect(detectAudioContainer(memoryInput(bytes),64)).rejects.toThrow('signature');}
  // Bytes 18..21 (the duration) are free; a short file is zero padded as native's probe buffer is.
  const duration=valid.slice();duration.set([0xff,0xff,0xff,0xff],18);expect(await probeWve(memoryInput(duration),3)).toBe(true);
  expect(await probeWve(memoryInput(valid.subarray(0,26)),64)).toBe(true);expect(await probeWve(memoryInput(valid.subarray(0,25)),64)).toBe(false);
  await expect(probeWve(memoryInput(valid),0)).rejects.toThrow('budget');
  // Another format's head never reaches the WVE confirmation.
  requests.length=0;expect(await detectAudioContainer(memoryInput(new TextEncoder().encode('.snd'),requests),64)).toBe('au');expect(requests).toEqual([{offset:0n,length:4}]);
});
it('refuses truncated headers read budgets and input seeks against a mismatched header duration',async()=>{
  await expect(openWve(memoryInput(wve(0,0).subarray(0,31)),{maxReadBytes:64})).rejects.toThrow('Truncated WVE header');
  await expect(openWve(memoryInput(wve(1,1)),{maxReadBytes:0})).rejects.toThrow('budget');
  for(const duration of [0,100,4000])await expect(openWve(memoryInput(wve(3000,duration)),{maxReadBytes:64,seek:1n})).rejects.toThrow('header duration');
  await expect(openWve(memoryInput(wve(3000,100)),{maxReadBytes:64,seek:0n})).resolves.toBeDefined();
  expect((await openWve(memoryInput(wve(3000,3000)),{maxReadBytes:64,seek:100000n})).info.durationSamples).toBe(3000n);
  const short=memoryInput(wve(4,4)),lying={size:short.size,readAt:async()=>new Uint8Array(0)};await expect(openWve(lying,{maxReadBytes:64})).rejects.toThrow('read length');
});
it('stops on abort before and during header reads',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(openWve(memoryInput(wve(10,10)),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stop');await expect(probeWve(memoryInput(wve(10,10)),64,controller.signal)).rejects.toThrow('stop');
  const late=new AbortController(),bytes=wve(10,10),source={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){late.abort(new Error('late'));return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openWve(source,{maxReadBytes:4,signal:late.signal})).rejects.toThrow('late');
  const reading=new AbortController(),input=await openWve(memoryInput(wve(100,100)),{maxReadBytes:64,signal:reading.signal});reading.abort(new Error('packets'));await expect(collect(input)).rejects.toThrow('packets');
});
it('registers a demux-only wve descriptor with an exact-magic probe and the default PCM packet span',async()=>{
  expect(containerFormat('wve')).toBe(descriptor);expect('mux' in descriptor).toBe(false);expect(Object.isFrozen(descriptor)&&Object.isFrozen(descriptor.demux)&&Object.isFrozen(descriptor.demux.probe)).toBe(true);
  expect(descriptor.demux).toMatchObject({headerBytes:32});expect(descriptor.demux.probe.precedence).toBe(100);expect('extensions' in descriptor.demux||'packetSpan' in descriptor.demux||'seekBeyondEnd' in descriptor.demux).toBe(false);
  expect(descriptor.demux.probe.head(new TextEncoder().encode('ALaw'))).toBe(true);expect(descriptor.demux.probe.head(new TextEncoder().encode('ALAW'))).toBe(false);
  expect(containerProbes.map(format=>format.name)).toContain('wve');
  const opened=await descriptor.demux.open(memoryInput(wve(5,5)),{maxReadBytes:64,signal:new AbortController().signal,declared:{sampleRate:44100,channels:1,guessLayout:true},seek:0n});expect(opened.info).toMatchObject({codec:'pcm_alaw',durationSamples:5n});
  await expect(descriptor.demux.open(memoryInput(wve(5,4)),{maxReadBytes:64,signal:new AbortController().signal,declared:{sampleRate:44100,channels:1,guessLayout:true},seek:1n})).rejects.toThrow('header duration');
});
