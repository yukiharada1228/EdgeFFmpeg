import { expect,it } from 'vitest';
import type { MediaPacket } from '@edge-ffmpeg/core';
import { framePcmPackets,planPcmFraming,PcmFramingError } from '../../packages/containers/src/pcm-framing.js';
import type { PcmFraming,PcmFramedChunk } from '../../packages/containers/src/pcm-framing.js';
// Contiguous zero-based mono s16 chunks of the given sample counts; byte 2k holds sample k (mod 256).
async function* chunks(...counts:number[]){let pts=0n;for(const count of counts){const data=Uint8Array.from({length:count*2},(_,index)=>index%2?0:(Number(pts)+index/2)%256);const packet:MediaPacket={streamIndex:0,data,pts,dts:pts,duration:BigInt(count),timeBase:{num:1n,den:10n},flags:1};pts+=BigInt(count);yield packet;}}
async function collect(framing:PcmFraming,counts:number[],signal?:AbortSignal){const pieces:PcmFramedChunk[]=[];for await(const piece of framePcmPackets(planPcmFraming(framing,'scratch'),chunks(...counts),signal))pieces.push(piece);return pieces;}
// Whole packets reassembled from the pieces: [pts, duration, first sample, byte length].
const packets=(pieces:PcmFramedChunk[])=>{const rows:[number,number,number,number][]=[];let bytes=0,first=-1;for(const piece of pieces){if(first<0)first=piece.bytes[0]!;bytes+=piece.bytes.length;if(piece.end){rows.push([Number(piece.pts),Number(piece.duration),first,bytes]);bytes=0;first=-1;}}return rows;};

it('yields bounded views at the span, a shorter first packet and the short tail, independent of input chunking',async()=>{
  const framing={blockAlign:2,samplesPerPacket:4n,firstPacketSamples:3n,sampleCount:10n,startPts:5n};
  const expected=[[5,3,0,6],[8,4,3,8],[12,3,7,6]];
  for(const counts of [[10],[1,1,1,1,1,1,1,1,1,1],[3,4,3],[2,5,3]])expect(packets(await collect(framing,counts)),counts.join()).toEqual(expected);
  // Pieces never span two input chunks and are views, not copies.
  const pieces=await collect(framing,[2,5,3]);expect(pieces.map(piece=>piece.bytes.length)).toEqual([4,2,8,6]);expect(pieces.every(piece=>piece.bytes.byteOffset%2===0&&piece.bytes.buffer.byteLength>=piece.bytes.length)).toBe(true);
  expect(pieces.filter(piece=>piece.end).length).toBe(3);expect(pieces.every(piece=>piece.duration===(piece.pts===8n?4n:3n))).toBe(true);
  expect(packets(await collect({blockAlign:2,samplesPerPacket:4n,sampleCount:0n},[]))).toEqual([]);
});
it('follows padding sections and cumulative packet schedules',async()=>{
  expect(packets(await collect({blockAlign:2,samplesPerPacket:4n,sampleCount:7n,sections:[{samples:5n,span:4n},{samples:2n,span:2n}]},[7]))).toEqual([[0,4,0,8],[4,1,4,2],[5,2,5,4]]);
  expect(packets(await collect({blockAlign:2,samplesPerPacket:4n,sampleCount:9n,sections:[{samples:3n,span:4n,firstPacketSamples:1n},{samples:6n,span:4n,firstPacketSamples:2n}]},[4,5]))).toEqual([[0,1,0,2],[1,2,1,4],[3,2,3,4],[5,4,5,8]]);
  const packetSchedule={sampleCount:7n,packetCount:3n,samplesForPackets:(n:bigint)=>n===0n?0n:n===1n?2n:n===2n?6n:7n};
  expect(packets(await collect({blockAlign:2,samplesPerPacket:1n,sampleCount:7n,packetSchedule},[3,4]))).toEqual([[0,2,0,4],[2,4,2,8],[6,1,6,2]]);
});
it('refuses malformed framing before reading, and malformed or incomplete input with the consumer label and error',async()=>{
  class Own extends Error {}
  for(const [framing,message] of [[{blockAlign:0,samplesPerPacket:4n,sampleCount:4n},'Invalid voc framing'],[{blockAlign:2,samplesPerPacket:4n,firstPacketSamples:5n,sampleCount:4n},'Invalid voc framing'],[{blockAlign:2,samplesPerPacket:4n,sampleCount:7n,sections:[{samples:6n,span:4n}]},'Invalid voc packet sections'],[{blockAlign:2,samplesPerPacket:1n,sampleCount:7n,packetSchedule:{sampleCount:6n,packetCount:1n,samplesForPackets:(n:bigint)=>n*6n}},'Invalid voc packet schedule']] as [PcmFraming,string][]){
    const plan=()=>planPcmFraming(framing,'voc',text=>new Own(text));expect(plan).toThrow(Own);expect(plan).toThrow(new RegExp(`^${message}$`));
  }
  expect(()=>planPcmFraming({blockAlign:0,samplesPerPacket:1n,sampleCount:0n},'voc')).toThrow(PcmFramingError);
  const plan=planPcmFraming({blockAlign:2,samplesPerPacket:4n,sampleCount:6n},'voc');
  const drain=async(source:AsyncIterable<MediaPacket>)=>{const ends:bigint[]=[];for await(const piece of framePcmPackets(plan,source))if(piece.end)ends.push(piece.pts);return ends;};
  async function* one(packet:Partial<MediaPacket>){yield {streamIndex:0,data:new Uint8Array(4),pts:0n,dts:0n,duration:2n,timeBase:{num:1n,den:10n},flags:1,...packet} as MediaPacket;}
  await expect(drain(one({data:new Uint8Array(3)}))).rejects.toThrow('Unaligned PCM voc chunk');
  for(const packet of [{pts:1n},{dts:1n},{duration:1n},{flags:0},{data:new Uint8Array(0),duration:0n},{data:new Uint8Array(14),duration:7n}])await expect(drain(one(packet)),JSON.stringify(packet,(_,value)=>typeof value==='bigint'?String(value):value)).rejects.toThrow('Invalid contiguous PCM voc chunks');
  // An input that stops early completes only its whole packets, then throws.
  const ends:bigint[]=[];await expect((async()=>{for await(const piece of framePcmPackets(plan,chunks(5)))if(piece.end)ends.push(piece.pts);})()).rejects.toThrow('Voc sample count mismatch');expect(ends).toEqual([0n]);
  const schedule=planPcmFraming({blockAlign:2,samplesPerPacket:1n,sampleCount:4n,packetSchedule:{sampleCount:4n,packetCount:2n,samplesForPackets:(n:bigint)=>n===0n?0n:n===1n?5n:4n}},'voc');
  await expect((async()=>{for await(const piece of framePcmPackets(schedule,chunks(4)))void piece;})()).rejects.toThrow('Invalid voc scheduled packet');
  const controller=new AbortController();controller.abort('cancel');await expect(collect({blockAlign:2,samplesPerPacket:4n,sampleCount:4n},[4],controller.signal)).rejects.toBe('cancel');
});
