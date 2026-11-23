import { expect,it } from 'vitest';
import { muxFrameCrc,frameCrcChecksum } from '@edge-ffmpeg/containers';
import type { MediaPacket } from '@edge-ffmpeg/core';
import { collectingOutput } from '../helpers/output.js';
const format={codec:'pcm_s16le',sampleRate:10,channelLayout:'mono'} as const;
function packet(overrides:Partial<MediaPacket>={}):MediaPacket{return {streamIndex:0,data:new Uint8Array([255,255]),pts:2n,dts:2n,duration:1n,timeBase:{num:1n,den:10n},flags:1,...overrides};}
async function* source(...packets:MediaPacket[]){yield* packets;}
it('writes zero-seed checksums, signed bigint timestamps, missing timestamps and flags',async()=>{
  expect(frameCrcChecksum(new Uint8Array())).toBe(0);expect(frameCrcChecksum(new Uint8Array([255,255]))).toBe(0x02fd01fe);
  const sink=collectingOutput();await muxFrameCrc(sink.output,format,source(packet(),packet({pts:9007199254740993n,dts:-2n,flags:0}),packet({pts:null,dts:null,duration:null,flags:3})),{bitexact:true,maxWriteBytes:7});
  const text=new TextDecoder().decode(sink.bytes());expect(text).toContain('0,          2,          2,        1,        2, 0x02fd01fe\n');
  expect(text).toContain('0,         -2, 9007199254740993,        1,        2, 0x02fd01fe, F=0x0\n');
  expect(text).toContain('0, -9223372036854775808, -9223372036854775808,        0,        2, 0x02fd01fe, F=0x3\n');
  expect(text).not.toContain('#software');expect(sink.lengths.every(length=>length<=7)).toBe(true);expect(sink.committed).toBe(true);
});
it('identifies its own software by default and commits an empty stream header',async()=>{
  const sink=collectingOutput();await muxFrameCrc(sink.output,format,source(),{maxWriteBytes:1024});expect(new TextDecoder().decode(sink.bytes())).toMatch(/^#software: EdgeFFmpeg\n#tb 0: 1\/10\n/);expect(sink.committed).toBe(true);
});
it('aborts invalid parameters, incompatible time bases and timestamps outside int64',async()=>{
  for(const value of [packet({timeBase:{num:1n,den:20n}}),packet({pts:1n<<63n}),packet({streamIndex:1}),packet({flags:-1})]){
    const sink=collectingOutput();await expect(muxFrameCrc(sink.output,format,source(value),{maxWriteBytes:8})).rejects.toThrow();expect(sink.aborted).toBe(true);expect(sink.committed).toBe(false);
  }
  const sink=collectingOutput();await expect(muxFrameCrc(sink.output,{...format,channelLayout:'mono\ninjected'},source(),{maxWriteBytes:8})).rejects.toThrow('parameters');expect(sink.aborted).toBe(true);
});
it('honors output backpressure and aborts on cancellation or failed writes',async()=>{
  let release=()=>{},notify=()=>{},produced=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),blocked=new Promise<void>(resolve=>{notify=resolve;});const sink=collectingOutput();
  async function* packets(){produced++;yield packet();produced++;yield packet();}
  let writes=0;const work=muxFrameCrc({...sink.output,async write(bytes){if(++writes===1){notify();await gate;}await sink.output.write(bytes);}},format,packets(),{maxWriteBytes:1024});
  await blocked;expect(produced).toBe(0);release();await work;expect(produced).toBe(2);
  const controller=new AbortController();const cancelled=collectingOutput();controller.abort('cancel');await expect(muxFrameCrc(cancelled.output,format,source(),{maxWriteBytes:8,signal:controller.signal})).rejects.toBe('cancel');expect(cancelled.aborted).toBe(true);
  const failed=collectingOutput();await expect(muxFrameCrc({...failed.output,async write(){throw new Error('write failed');}},format,source(packet()),{maxWriteBytes:8})).rejects.toThrow('write failed');expect(failed.aborted).toBe(true);
});
it('regroups split PCM chunks with constant checksum state and validates the declared sample count',async()=>{
  const chunks=source(packet({data:new Uint8Array([1,0]),pts:0n,dts:0n}),packet({data:new Uint8Array([2,0,3,0,4,0]),pts:1n,dts:1n,duration:3n}));
  const sink=collectingOutput();await muxFrameCrc(sink.output,format,chunks,{bitexact:true,maxWriteBytes:4,framing:{blockAlign:2,samplesPerPacket:3n,firstPacketSamples:2n,sampleCount:4n,startPts:7n}});
  const text=new TextDecoder().decode(sink.bytes());expect(text).toContain('0,          7,          7,        2,        4, 0x00080003\n');expect(text).toContain('0,          9,          9,        2,        4, 0x00140007\n');
  for(const packets of [source(packet({pts:0n,dts:0n})),source(packet({pts:1n,dts:1n})),source(packet({data:new Uint8Array(3),pts:0n,dts:0n}))]){
    const failed=collectingOutput();await expect(muxFrameCrc(failed.output,format,packets,{maxWriteBytes:8,framing:{blockAlign:2,samplesPerPacket:3n,sampleCount:2n}})).rejects.toThrow();expect(failed.aborted).toBe(true);expect(failed.committed).toBe(false);
  }
});
it('regroups bounded chunks across explicit packet sections and rejects malformed section schedules',async()=>{
  const sink=collectingOutput(),framing={blockAlign:2,samplesPerPacket:4n,sampleCount:7n,sections:[{samples:5n,span:4n},{samples:2n,span:2n}]};
  await muxFrameCrc(sink.output,format,source(packet({data:new Uint8Array(14),pts:0n,dts:0n,duration:7n})),{maxWriteBytes:8,bitexact:true,framing});const rows=new TextDecoder().decode(sink.bytes()).split('\n').filter(line=>line.startsWith('0,')).map(line=>line.split(',').slice(1,5).map(value=>Number(value.trim())));expect(rows).toEqual([[0,0,4,8],[4,4,1,2],[5,5,2,4]]);
  for(const sections of [[{samples:7n,span:0n}],[{samples:6n,span:4n}],Array<{samples:bigint;span:bigint}>(1)]){const failed=collectingOutput();await expect(muxFrameCrc(failed.output,format,source(),{maxWriteBytes:8,framing:{...framing,sections}})).rejects.toThrow('sections');expect(failed.aborted).toBe(true);}
});
it('uses cumulative packet schedules without retaining whole semantic packets and aborts invalid boundaries',async()=>{
  const packetSchedule={sampleCount:7n,packetCount:3n,samplesForPackets:(n:bigint)=>n===0n?0n:n===1n?2n:n===2n?6n:7n},framing={blockAlign:2,samplesPerPacket:1n,sampleCount:7n,packetSchedule},sink=collectingOutput();
  await muxFrameCrc(sink.output,format,source(packet({data:new Uint8Array(14),pts:0n,dts:0n,duration:7n})),{maxWriteBytes:4,bitexact:true,framing});expect(new TextDecoder().decode(sink.bytes()).split('\n').filter(line=>line.startsWith('0,')).map(line=>BigInt(line.split(',')[3]!.trim()))).toEqual([2n,4n,1n]);expect(sink.committed).toBe(true);
  for(const invalid of [{...packetSchedule,packetCount:0n},{...packetSchedule,samplesForPackets:(n:bigint)=>n===3n?7n:0n},{...packetSchedule,sampleCount:6n}]){
    const failed=collectingOutput();await expect(muxFrameCrc(failed.output,format,source(),{maxWriteBytes:8,framing:{...framing,packetSchedule:invalid}})).rejects.toThrow('schedule');expect(failed.aborted).toBe(true);expect(failed.committed).toBe(false);
  }
});
