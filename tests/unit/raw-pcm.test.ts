import { expect,it } from 'vitest';
import { openRawPcm,muxRawPcm,rawPcmCodec } from '@edge-ffmpeg/containers';
import type { ReadHandle,MediaPacket } from '@edge-ffmpeg/core';
import { memoryInput } from '../helpers/wav.js';
import { collectingOutput } from '../helpers/output.js';
const format={codec:'pcm_s16le',channels:1,sampleRate:8000} as const;
it('reads aligned bounded raw packets, seeks exactly and preserves bigint offsets',async()=>{
  const requests:Array<{offset:bigint;length:number}>=[];
  const input=await openRawPcm(memoryInput(new Uint8Array([1,0,2,0,3,0,4,0]),requests),{...format,maxReadBytes:5});
  expect(requests).toHaveLength(0);const packets=[];for await(const packet of input.packets(1n))packets.push(packet);
  expect(packets.map(packet=>[packet.pts,packet.duration,[...packet.data]])).toEqual([[1n,2n,[2,0,3,0]],[3n,1n,[4,0]]]);
  expect(requests.every(request=>request.length<=5)).toBe(true);
  const size=9007199254740996n,offsets:bigint[]=[];
  const large:ReadHandle={size,async readAt(offset,length){offsets.push(offset);return new Uint8Array(length);}};
  const source=await openRawPcm(large,{codec:'pcm_u8',channels:1,sampleRate:44100,maxReadBytes:8});
  const iterator=source.packets(source.info.durationSamples-1n)[Symbol.asyncIterator]();
  const last=(await iterator.next()).value;expect(last?.duration).toBe(1n);expect(last?.pts).toBe(size-1n);expect(offsets).toEqual([size-1n]);await iterator.return?.();
});
it('handles short reads and empty streams but rejects partial sample frames and bad declarations',async()=>{
  const handle=memoryInput(new Uint8Array([1,0,2,0]));
  const input=await openRawPcm({size:handle.size,readAt:(offset,length)=>handle.readAt(offset,Math.min(length,1))},{...format,maxReadBytes:8});
  expect([...(await input.packets()[Symbol.asyncIterator]().next()).value!.data]).toEqual([1,0,2,0]);
  const empty=await openRawPcm(memoryInput(new Uint8Array()),{...format,maxReadBytes:8});expect((await empty.packets()[Symbol.asyncIterator]().next()).done).toBe(true);
  await expect(openRawPcm(memoryInput(new Uint8Array(3)),{...format,maxReadBytes:8})).rejects.toThrow('Incomplete');
  await expect(openRawPcm(handle,{...format,maxReadBytes:1})).rejects.toThrow('budget');
  await expect(openRawPcm(handle,{...format,channels:0,maxReadBytes:8})).rejects.toThrow('parameters');
  expect(rawPcmCodec('f64le')).toBe('pcm_f64le');expect(rawPcmCodec('__proto__')).toBeNull();
});
it('writes raw bytes without headers, waits on writes and commits only matching counts',async()=>{
  const input=await openRawPcm(memoryInput(new Uint8Array([1,0,2,0,3,0])),{...format,maxReadBytes:4});
  const sink=collectingOutput();await muxRawPcm(sink.output,format,input.packets(),{sampleCount:3n,maxWriteBytes:3});
  expect(sink.committed).toBe(true);expect([...sink.bytes()]).toEqual([1,0,2,0,3,0]);expect(sink.lengths.every(length=>length<=3)).toBe(true);
  const failed=collectingOutput();await expect(muxRawPcm(failed.output,format,input.packets(),{sampleCount:4n,maxWriteBytes:4})).rejects.toThrow('declared duration');expect(failed.aborted).toBe(true);
});
it('aborts on invalid timestamps, cancellation and input failures',async()=>{
  async function* packets():AsyncIterable<MediaPacket>{yield {streamIndex:0,data:new Uint8Array(2),pts:1n,dts:1n,duration:1n,timeBase:{num:1n,den:8000n},flags:1};}
  const sink=collectingOutput();await expect(muxRawPcm(sink.output,format,packets(),{sampleCount:1n,maxWriteBytes:8})).rejects.toThrow('timestamps');expect(sink.aborted).toBe(true);
  const abort=new AbortController();abort.abort('stop');await expect(openRawPcm(memoryInput(new Uint8Array()),{...format,maxReadBytes:8,signal:abort.signal})).rejects.toBe('stop');
  const source=await openRawPcm({size:2n,async readAt(){return new Uint8Array();}},{...format,maxReadBytes:8});const failed=collectingOutput();await expect(muxRawPcm(failed.output,format,source.packets(),{sampleCount:1n,maxWriteBytes:8})).rejects.toThrow('read length');expect(failed.aborted).toBe(true);
});

it('does not request another raw packet while an output write is blocked',async()=>{
  let release=()=>{},notify=()=>{},produced=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),blocked=new Promise<void>(resolve=>{notify=resolve;});
  const sink=collectingOutput();let writes=0;
  async function* packets():AsyncIterable<MediaPacket>{for(let i=0;i<2;i++){produced++;yield{streamIndex:0,data:new Uint8Array([i,0]),pts:BigInt(i),dts:BigInt(i),duration:1n,timeBase:{num:1n,den:8000n},flags:1};}}
  const work=muxRawPcm({...sink.output,async write(bytes){if(++writes===1){notify();await gate;}await sink.output.write(bytes);}},format,packets(),{sampleCount:2n,maxWriteBytes:8});
  await blocked;expect(produced).toBe(1);expect(sink.committed).toBe(false);release();await work;
  expect(produced).toBe(2);expect(sink.committed).toBe(true);expect([...sink.bytes()]).toEqual([0,0,1,0]);
});
