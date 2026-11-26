import {expect,it} from 'vitest';
import {containerFormat,containerFormats,outputContainerFor} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {muxSmjpeg,smjpeg,smjpegDuration,smjpegHeader,smjpegMilliseconds,smjpegRescale,supportsSmjpegCodec,validateSmjpegOutput} from '../../packages/containers/src/smjpeg.js';
import {collectingOutput} from '../helpers/output.js';
const ascii=(text:string)=>[...text].map(char=>char.charCodeAt(0));
const be32=(value:number)=>[value>>>24&255,value>>>16&255,value>>>8&255,value&255];
const format=(fields:Partial<{codec:string;channels:number;sampleRate:number;samples:bigint;bitexact:boolean}>={})=>({codec:'pcm_s16le',channels:1,sampleRate:44100,samples:5000n,bitexact:true,...fields});
const refusal=(exitCode:number)=>expect.objectContaining({code:'unsupported-command',exitCode});
async function* chunks(data:Uint8Array,align:number,sizes:number[],rate=44100):AsyncGenerator<MediaPacket>{
  let at=0,pts=0n;for(let index=0;at<data.length;index++){const bytes=Math.min(sizes[index%sizes.length]!*align,data.length-at);yield {streamIndex:0,data:data.subarray(at,at+bytes),pts,dts:pts,duration:BigInt(bytes/align),timeBase:{num:1n,den:BigInt(rate)},flags:1};at+=bytes;pts+=BigInt(bytes/align);}
}
const ramp=(bytes:number)=>Uint8Array.from({length:bytes},(_,i)=>(i*151+(i>>3)*17)&255);
it('writes the native SMJPEG header with and without the encoder text chunk',()=>{
  const head=[...ascii('\0\nSMJPEG'),0,0,0,0,...be32(113)],sndChunk=(rate:number,channels:number)=>[...ascii('_SND'),...be32(8),rate>>8&255,rate&255,16,channels,...ascii('NONE')];
  expect([...smjpegHeader(format(),113n)]).toEqual([...head,...sndChunk(44100,1),...ascii('HEND')]);
  const text=ascii('encoder = Lavf63.1.102');expect(text.length).toBe(22);
  expect([...smjpegHeader(format({bitexact:false,channels:6,sampleRate:48000}),113n)]).toEqual([...head,...ascii('_TXT'),...be32(22),...text,...sndChunk(48000,6),...ascii('HEND')]);
  // avio_wb16 keeps the low 16 bits of the rate, the duration field is a uint32_t.
  expect([...smjpegHeader(format({sampleRate:96000,channels:255}),(1n<<32n)+5n).subarray(12,36)]).toEqual([...be32(5),...sndChunk(96000&0xffff,255),...ascii('HEND')].slice(0,24));
  expect(smjpegHeader(format({sampleRate:65536}),0n)[25]).toBe(0);
});
it('rescales sample timestamps to milliseconds with av_rescale_rnd NEAR_INF on half-way cases',()=>{
  const table:Array<[bigint,number,bigint]>=[[0n,44100,0n],[4096n,44100,93n],[904n,44100,20n],[4n,8000,1n],[12n,8000,2n],[3n,8000,0n],[5n,8000,1n],[24n,48000,1n],[72n,48000,2n],[23n,48000,0n],[1n,2000,1n],[3n,2000,2n],[1n,1000,1n],[11025n,11025,1000n],[5512n,11025,500n],[5513n,11025,500n],[1n,96000,0n],[48n,96000,1n],[1n,2147483647,0n],[(1n<<40n),48000,22906492245n]];
  for(const [samples,rate,ms]of table)expect(smjpegMilliseconds(samples,rate),`${samples}@${rate}`).toBe(ms);
  expect(smjpegRescale(-4n,1000n,8000n)).toBe(-1n);expect(smjpegRescale(-3n,1000n,8000n)).toBe(0n);
});
it('regroups arbitrary input chunks to native packet boundaries with ms timestamps and the max(pts + duration) trailer',async()=>{
  const data=ramp(5000*2),sink=collectingOutput(),framing={blockAlign:2,samplesPerPacket:4096n,sampleCount:5000n};
  expect(await smjpegDuration(format(),framing)).toBe(113n);
  await muxSmjpeg(sink.output,format(),chunks(data,2,[1000,7,2500]),{maxWriteBytes:4096,framing});expect(sink.committed).toBe(true);
  const bytes=sink.bytes(),header=smjpegHeader(format(),113n);
  expect([...bytes.subarray(0,header.length)]).toEqual([...header]);let at=header.length;
  expect([...bytes.subarray(at,at+12)]).toEqual([...ascii('sndD'),...be32(0),...be32(8192)]);expect(bytes.subarray(at+12,at+12+8192)).toEqual(data.subarray(0,8192));at+=12+8192;
  expect([...bytes.subarray(at,at+12)]).toEqual([...ascii('sndD'),...be32(93),...be32(1808)]);expect(bytes.subarray(at+12,at+12+1808)).toEqual(data.subarray(8192));at+=12+1808;
  expect([...bytes.subarray(at)]).toEqual(ascii('DONE'));
  // A shorter first packet, a start offset and a packet schedule follow framing exactly as framecrc does.
  const first=collectingOutput();await muxSmjpeg(first.output,format({sampleRate:8000,samples:20n}),chunks(ramp(40),2,[3],8000),{maxWriteBytes:64,framing:{blockAlign:2,samplesPerPacket:8n,firstPacketSamples:4n,sampleCount:20n,startPts:4n}});
  const out=first.bytes(),rows:Array<[number,number]>=[];for(let i=36;i+12<=out.length-4;){const view=new DataView(out.buffer,out.byteOffset+i);rows.push([view.getUint32(4),view.getUint32(8)]);i+=12+view.getUint32(8);}
  expect(rows).toEqual([[1,8],[1,16],[2,16]]);expect(new DataView(out.buffer).getUint32(12)).toBe(3);
  const scheduled={blockAlign:2,samplesPerPacket:4096n,sampleCount:10n,packetSchedule:{sampleCount:10n,packetCount:3n,samplesForPackets:(n:bigint)=>[0n,2n,7n,10n][Number(n)]!}};
  expect(await smjpegDuration(format({sampleRate:1000,samples:10n}),scheduled)).toBe(10n);
});
it('writes in chunks of at most maxWriteBytes with identical bytes',async()=>{
  const data=ramp(300*4),framing={blockAlign:4,samplesPerPacket:64n,sampleCount:300n},whole=collectingOutput(),small=collectingOutput(),fmt=format({channels:2,sampleRate:11025,samples:300n,bitexact:false});
  await muxSmjpeg(whole.output,fmt,chunks(data,4,[300],11025),{maxWriteBytes:1<<20,framing});await muxSmjpeg(small.output,fmt,chunks(data,4,[5,77],11025),{maxWriteBytes:5,framing});
  expect(small.lengths.every(length=>length<=5)).toBe(true);expect(small.bytes()).toEqual(whole.bytes());
  expect(whole.bytes().length).toBe(66+5*12+300*4+4);
});
it('refuses unsupported codecs, layouts, framing and budgets before writing, and aborts once on failure',async()=>{
  for(const codec of ['pcm_s16be','pcm_u8','pcm_s24le','pcm_f32le'])expect(()=>validateSmjpegOutput(format({codec}))).toThrow(refusal(234));
  expect(()=>validateSmjpegOutput(format({channels:256}))).toThrow('more than 255 channels');
  for(const fields of [{channels:0},{sampleRate:0},{samples:-1n},{channels:1.5}])expect(()=>validateSmjpegOutput(format(fields))).toThrow('Invalid SMJPEG output parameters');
  validateSmjpegOutput(format({channels:255,sampleRate:2147483647}));
  const fail=async(fmt:ReturnType<typeof format>,framing:{blockAlign:number;samplesPerPacket:bigint;sampleCount:bigint},packets:AsyncIterable<MediaPacket>,maxWriteBytes=64,signal?:AbortSignal)=>{
    let aborts=0;const sink=collectingOutput(),output={...sink.output,async abort(reason:unknown){aborts++;await sink.output.abort(reason);}};
    const error=await muxSmjpeg(output,fmt,packets,{maxWriteBytes,framing,...(signal?{signal}:{})}).then(()=>null,(caught:unknown)=>caught);
    expect(aborts).toBe(1);expect(sink.committed).toBe(false);return {error,lengths:sink.lengths};
  };
  const empty=async function*():AsyncGenerator<MediaPacket>{};
  expect((await fail(format({codec:'pcm_s16be'}),{blockAlign:2,samplesPerPacket:8n,sampleCount:5000n},empty())).error).toEqual(refusal(234));
  expect(String((await fail(format(),{blockAlign:4,samplesPerPacket:8n,sampleCount:5000n},empty())).error)).toContain('Invalid smjpeg framing');
  expect(String((await fail(format(),{blockAlign:2,samplesPerPacket:8n,sampleCount:4999n},empty())).error)).toContain('Invalid smjpeg framing');
  expect(String((await fail(format(),{blockAlign:2,samplesPerPacket:0n,sampleCount:5000n},empty())).error)).toContain('Invalid smjpeg framing');
  expect(String((await fail(format(),{blockAlign:2,samplesPerPacket:8n,sampleCount:5000n},empty(),0)).error)).toContain('write budget');
  const truncated=await fail(format(),{blockAlign:2,samplesPerPacket:4096n,sampleCount:5000n},chunks(ramp(4200*2),2,[4200]));
  expect(String(truncated.error)).toContain('Smjpeg sample count mismatch');
  const badBase=await fail(format(),{blockAlign:2,samplesPerPacket:4096n,sampleCount:5000n},chunks(ramp(5000*2),2,[5000],48000));expect(String(badBase.error)).toContain('Invalid SMJPEG packet');
  const unaligned=await fail(format(),{blockAlign:2,samplesPerPacket:4096n,sampleCount:5000n},(async function*(){yield {streamIndex:0,data:new Uint8Array(3),pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:44100n},flags:1};})());expect(String(unaligned.error)).toContain('Unaligned PCM smjpeg chunk');
  const controller=new AbortController();controller.abort(new Error('stop'));
  const aborted=await fail(format(),{blockAlign:2,samplesPerPacket:4096n,sampleCount:5000n},chunks(ramp(5000*2),2,[5000]),64,controller.signal);expect(String(aborted.error)).toContain('stop');expect(aborted.lengths).toEqual([]);
  const late=new AbortController();let yielded=0;
  const stopping=await fail(format(),{blockAlign:2,samplesPerPacket:4096n,sampleCount:5000n},(async function*(){for await(const packet of chunks(ramp(5000*2),2,[100])){if(++yielded===3)late.abort(new Error('late'));yield packet;}})(),64,late.signal);expect(String(stopping.error)).toContain('late');
});
it('registers a mux-only SMJPEG descriptor without an output extension',()=>{
  const descriptor=containerFormat('smjpeg');expect(descriptor).toBe(smjpeg);expect(containerFormats).toContain(smjpeg);
  expect('demux' in smjpeg).toBe(false);expect(smjpeg.mux).toMatchObject({label:'SMJPEG',defaultCodec:'pcm_s16le',scratchBytes:128});
  expect('extensions' in smjpeg.mux).toBe(false);expect('dropsMetadata' in smjpeg.mux).toBe(false);expect(outputContainerFor('/x.smjpeg')).toBeUndefined();expect(outputContainerFor('/x.mjpg')).toBeUndefined();
  expect(supportsSmjpegCodec('pcm_s16le')).toBe(true);expect(supportsSmjpegCodec('pcm_s16be')).toBe(false);
  expect(smjpeg.mux.refuse('pcm_u8')).toEqual(refusal(234));expect(smjpeg.mux.refuse('pcm_u8').message).toBe('SMJPEG muxer does not support pcm_u8');
  expect(Object.isFrozen(smjpeg)&&Object.isFrozen(smjpeg.mux)).toBe(true);
});
