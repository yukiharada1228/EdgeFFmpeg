import {expect,it} from 'vitest';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {muxVoc,openVoc,supportsVocCodec,validateVocOutput,voc,vocBlockRate,vocFileHeader,vocFirstBlockHeader,vocProbeScore} from '../../packages/containers/src/voc.js';
import type {VocCodec} from '../../packages/containers/src/voc.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
const header=(version=0x0114,check=(~version+0x1234)&0xffff,size=26)=>{const b=new Uint8Array(26),v=new DataView(b.buffer);b.set(new TextEncoder().encode('Creative Voice File\x1a'));v.setUint16(20,size,true);v.setUint16(22,version,true);v.setUint16(24,check,true);return b;};
const block=(type:number,body:Uint8Array|number[],size=body.length)=>{const b=new Uint8Array(4+body.length);b[0]=type;b[1]=size&255;b[2]=size>>8&255;b[3]=size>>16;b.set(body,4);return b;};
const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;};
const bytes=(count:number,seed=0)=>Uint8Array.from({length:count},(_,i)=>(i*7+seed)&255);
const type1=(tc:number,tag:number,data:Uint8Array)=>block(1,concat(Uint8Array.of(tc,tag),data));
const type9=(rate:number,bits:number,channels:number,tag:number,data:Uint8Array)=>{const h=new Uint8Array(12),v=new DataView(h.buffer);v.setUint32(0,rate,true);h[4]=bits;h[5]=channels;v.setUint16(6,tag,true);return block(9,concat(h,data));};
const type8=(rate:number,channels:number)=>block(8,[rate&255,rate>>8,0,channels-1]);
const refusal=(exitCode:number)=>expect.objectContaining({code:'unsupported-command',exitCode});
async function collect(input:{packets(start?:bigint,max?:number):AsyncIterable<MediaPacket>},start=0n,max?:number){const out:Array<[bigint|null,number[]]>=[];for await(const packet of input.packets(start,max))out.push([packet.pts,[...packet.data]]);return out;}
async function*chunks(data:Uint8Array,align:number,sizes:number[]):AsyncIterable<MediaPacket>{let offset=0;for(const size of sizes){const pts=BigInt(offset/align);yield {streamIndex:0,data:data.slice(offset,offset+size),pts,dts:pts,duration:BigInt(size/align),timeBase:{num:1n,den:8000n},flags:1};offset+=size;}}
it('parses type 1, type 8 + type 1 and type 9 VOC block chains with bounded reads and integer rate formulas',async()=>{
  expect([0x83,0,255,0x9c].map(tc=>vocBlockRate(tc))).toEqual([8000,3906,1000000,10000]);
  expect(vocBlockRate(0x83,{rate:65536-11609,channels:2})).toBe(11025);expect(vocBlockRate(0x9c,{rate:0,channels:2})).toBe(1953);expect(vocBlockRate(0,{rate:65535,channels:256})).toBe(1000000);
  const requests:Array<{offset:bigint;length:number}>=[],one=await openVoc(memoryInput(concat(header(),type1(0x83,0,bytes(3000)),Uint8Array.of(0)),requests),{maxReadBytes:1});
  expect(one.info).toMatchObject({container:'voc',codec:'pcm_u8',channels:1,sampleRate:8000,channelMask:null,blockAlign:1,dataOffset:32n,dataBytes:3000n,durationSamples:3000n,firstBlock:1,extended:false,blocks:1n,packetSamples:2048n,version:0x0114});
  expect(one.info.copyRefusal).toBeUndefined();expect(requests.every(request=>request.length===1)).toBe(true);expect(requests.length).toBe(26+4+2+1);
  const stereo=await openVoc(memoryInput(concat(header(),type8(65536-11609,2),type1(0xa5,4,bytes(2000)),block(2,bytes(2000,1)),block(2,bytes(400,2)))),{maxReadBytes:4096});
  expect(stereo.info).toMatchObject({codec:'pcm_s16le',channels:2,sampleRate:11025,blockAlign:4,blocks:3n,blockPayload:2000n,lastPayload:400n,durationSamples:1100n,packetSamples:500n,extended:true});
  expect(stereo.info.copyRefusal).toContain('bit width');
  const packets=await collect(stereo,0n,1600);expect(packets.map(([pts,data])=>[pts,data.length])).toEqual([[0n,1600],[400n,400],[500n,1600],[900n,400],[1000n,400]]);
  expect(packets[2]![1]).toEqual([...bytes(1600,1)]);expect((await collect(stereo,1099n))).toEqual([[1099n,[...bytes(400,2).subarray(396)]]]);
  for(const [codec,tag,bits,align]of [['pcm_u8',0,8,2],['pcm_s16le',4,16,4],['pcm_alaw',6,8,2],['pcm_mulaw',7,8,2]] as const){
    const input=await openVoc(memoryInput(concat(header(),type9(44100,bits,2,tag,bytes(4096)),block(2,bytes(4096,1)),block(2,bytes(300*align,2)),Uint8Array.of(0,1,2,3))),{maxReadBytes:4096});
    expect(input.info).toMatchObject({codec,channels:2,sampleRate:44100,blockAlign:align,firstBlock:9,dataOffset:42n,blocks:3n,durationSamples:BigInt(8192/align+300),packetSamples:BigInt(2048/align)});expect(input.info.copyRefusal).toBeUndefined();
    // Three channels: 2048-byte packets would split a frame, so only blocks of at most 2048 bytes are accepted.
    await expect(openVoc(memoryInput(concat(header(),type9(44100,bits,3,tag,bytes(4096*3*align/2)))),{maxReadBytes:4096})).rejects.toThrow('split a sample frame');
    expect((await openVoc(memoryInput(concat(header(),type9(44100,bits,3,tag,bytes(300*3*align/2)))),{maxReadBytes:4096})).info.packetSamples).toBe(300n);
  }
  const odd=await openVoc(memoryInput(concat(header(),type9(8000,12,1,4,bytes(10)))),{maxReadBytes:64});expect(odd.info.copyRefusal).toContain('bit width');
});
it('accepts only one uniform VOC packet span and refuses unmirrored layouts and fields',async()=>{
  const open=(...parts:Uint8Array[])=>openVoc(memoryInput(concat(header(),...parts)),{maxReadBytes:4096});
  expect((await open(type9(8000,16,1,4,bytes(4096)),block(2,bytes(4096)),block(2,bytes(10000)))).info).toMatchObject({packetSamples:1024n,durationSamples:9096n});
  expect((await open(type9(8000,16,1,4,bytes(2048)),block(2,bytes(6000)))).info.packetSamples).toBe(1024n);
  expect((await open(type9(8000,16,1,4,bytes(1000)),block(2,bytes(1000)),block(2,bytes(1000)))).info.packetSamples).toBe(500n);
  await expect(open(type9(8000,16,1,4,bytes(1000)),block(2,bytes(1002)))).rejects.toThrow('uniform');
  await expect(open(type9(8000,16,1,4,bytes(1000)),block(2,bytes(900)),block(2,bytes(10)))).rejects.toThrow('uniform');
  await expect(open(type9(8000,16,1,4,bytes(3000)),block(2,bytes(3000)))).rejects.toThrow('uniform');
  await expect(open(type9(8000,16,3,4,bytes(4096*3)),block(2,bytes(6)))).rejects.toThrow('split a sample frame');
  await expect(open(type9(8000,16,1,4,bytes(11)))).rejects.toThrow('split a sample frame');
  await expect(open(type9(8000,16,1,4,bytes(10)),type9(8000,16,1,4,bytes(10)))).rejects.toThrow('Repeated');
  await expect(open(type1(0x83,0,bytes(10)),type1(0x83,4,bytes(10)))).rejects.toThrow('Repeated');
  await expect(open(type1(0x83,0,bytes(10)),type8(1,2))).rejects.toThrow('extended');
  await expect(open(type8(1,2),type9(8000,16,1,4,bytes(10)))).rejects.toThrow('type 9');
  await expect(open(block(8,[1,2,3,4,5]),type1(0x83,0,bytes(10)))).rejects.toThrow('4 bytes');
  for(const type of [3,4,5,6,7,10])await expect(open(type1(0x83,0,bytes(10)),block(type,[1,2,3]))).rejects.toThrow(`type ${type}`);
  await expect(open(block(2,bytes(10)))).rejects.toThrow('continuation');
  await expect(open(type1(0x83,0,bytes(10)),block(2,bytes(10),0))).rejects.toThrow('size 0');
  await expect(open(type1(0x83,0,new Uint8Array(0)))).rejects.toThrow('Empty');
  await expect(open(block(1,[0x83]))).rejects.toThrow('Invalid VOC block 1 size 1');
  await expect(open(block(9,bytes(11)))).rejects.toThrow('Invalid VOC block 9 size 11');
  for(const tag of [1,2,3,0x200])await expect(open(type9(8000,4,1,tag,bytes(10)))).rejects.toThrow('ADPCM');
  await expect(open(type1(0x83,5,bytes(10)))).rejects.toThrow('unknown codec tag');
  await expect(open(type9(0,16,1,4,bytes(10)))).rejects.toThrow('Invalid sample rate 0');
  await expect(open(type9(0x80000000,16,1,4,bytes(10)))).rejects.toThrow('Invalid sample rate -2147483648');
  await expect(open(type9(8000,16,0,4,bytes(10)))).rejects.toThrow('channel count 0');
  await expect(open(type1(0x83,0,bytes(10)).subarray(0,10))).rejects.toThrow('Truncated VOC block');
  await expect(open(type1(0x83,0,bytes(10)),Uint8Array.of(2,1))).rejects.toThrow('Truncated VOC block header');
  await expect(open(Uint8Array.of(0),type1(0x83,0,bytes(10)))).rejects.toThrow('no voice data');
  for(const size of [0,22,25,27])await expect(openVoc(memoryInput(concat(header(0x0114,undefined,size),type1(0x83,0,bytes(10)))),{maxReadBytes:64})).rejects.toEqual(refusal(218));
  await expect(openVoc(memoryInput(header().subarray(0,10)),{maxReadBytes:64})).rejects.toEqual(refusal(218));
  await expect(openVoc(memoryInput(header().subarray(0,24)),{maxReadBytes:64})).rejects.toThrow('Truncated VOC header');
  await expect(openVoc(memoryInput(header()),{maxReadBytes:0})).rejects.toThrow('read budget');
  const input=await open(type1(0x83,0,bytes(10)));await expect(collect(input,11n)).rejects.toThrow('seek outside');await expect(collect(input,0n,0)).rejects.toThrow('packet budget');
  const controller=new AbortController();controller.abort();await expect(openVoc(memoryInput(header()),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow();
});
it('probes the VOC magic and claims only the score-100 version check',async()=>{
  expect(vocProbeScore(header())).toBe(100);expect(vocProbeScore(header(0x010a))).toBe(100);expect(vocProbeScore(header(0x0114,0))).toBe(10);
  expect(vocProbeScore(header(0x1234,0xffff))).toBe(10);expect(vocProbeScore(header(0x1233,0))).toBe(100);expect(vocProbeScore(header().subarray(0,20))).toBe(10);
  const bad=header();bad[19]=0;expect(vocProbeScore(bad)).toBe(0);
  const file=concat(header(),type1(0x83,0,bytes(10)));expect(await detectAudioContainer(memoryInput(file),3)).toBe('voc');
  await expect(detectAudioContainer(memoryInput(concat(header(0x0114,0),type1(0x83,0,bytes(10)))),64)).rejects.toThrow('signature');
  await expect(detectAudioContainer(memoryInput(concat(header(0x0114,0),type1(0x83,0,bytes(10)))),64,undefined,'/x.voc')).rejects.toThrow('signature');
  expect(voc.demux.probe.head(new TextEncoder().encode('Crea'))).toBe(true);expect(voc.demux.probe.head(new TextEncoder().encode('Creb'))).toBe(false);
});
it('writes native VOC header, first-block and continuation words',async()=>{
  expect([...vocFileHeader().subarray(19)]).toEqual([0x1a,0x1a,0x00,0x14,0x01,0x1f,0x11]);
  expect([...vocFirstBlockHeader({codec:'pcm_s16le',channels:2,sampleRate:44100},4096)]).toEqual([9,0x0c,0x10,0,0x44,0xac,0,0,16,2,4,0,0,0,0,0]);
  expect([...vocFirstBlockHeader({codec:'pcm_alaw',channels:1,sampleRate:8000},10)]).toEqual([9,22,0,0,0x40,0x1f,0,0,8,1,6,0,0,0,0,0]);
  expect([...vocFirstBlockHeader({codec:'pcm_mulaw',channels:1,sampleRate:8000},10)].slice(8,11)).toEqual([8,1,7]);
  expect([...vocFirstBlockHeader({codec:'pcm_u8',channels:1,sampleRate:8000},4096)]).toEqual([1,0x02,0x10,0,0x83,0]);
  // 256 - (1000000 + 1500) / 3000 = -77 wraps to 179; 65536 - (256000000 + 4500) / 9000 = 37092.
  expect([...vocFirstBlockHeader({codec:'pcm_u8',channels:3,sampleRate:3000},3)]).toEqual([8,4,0,0,37092&255,37092>>8,0,2,1,5,0,0,179,0]);
  expect([...vocFirstBlockHeader({codec:'pcm_u8',channels:2,sampleRate:11025},2)]).toEqual([8,4,0,0,...[(65536-11610)&255,(65536-11610)>>8],0,1,1,4,0,0,165,0]);
  expect(()=>vocFirstBlockHeader({codec:'pcm_s16le',channels:1,sampleRate:8000},0xffffff-11)).toThrow('24-bit');expect(vocFirstBlockHeader({codec:'pcm_s16le',channels:1,sampleRate:8000},0xffffff-12)[3]).toBe(0xff);
  expect(()=>validateVocOutput({codec:'pcm_s24le' as VocCodec,channels:1,sampleRate:8000})).toThrow(expect.objectContaining({message:'unsupported codec',exitCode:234}));
  expect(()=>validateVocOutput({codec:'pcm_u8',channels:256,sampleRate:8000})).toThrow('parameters');expect(()=>validateVocOutput({codec:'pcm_u8',channels:2,sampleRate:1200000000})).toThrow('overflows');
  expect(()=>validateVocOutput({codec:'pcm_s16le',channels:2,sampleRate:1200000000})).not.toThrow();
  expect(['pcm_u8','pcm_s16le','pcm_alaw','pcm_mulaw','pcm_s8','pcm_s16be','pcm_s24le'].map(supportsVocCodec)).toEqual([true,true,true,true,false,false,false]);
});
it('muxes one VOC block per native packet from the framing and writes the terminator',async()=>{
  const data=bytes(2400),sink=collectingOutput();
  await muxVoc(sink.output,{codec:'pcm_s16le',channels:2,sampleRate:8000},chunks(data,4,[1000,1000,400]),{maxWriteBytes:7,framing:{blockAlign:4,samplesPerPacket:250n,firstPacketSamples:100n,sampleCount:600n}});
  const out=sink.bytes();expect(sink.committed).toBe(true);expect(Math.max(...sink.lengths)).toBeLessThanOrEqual(7);
  expect(out.length).toBe(26+16+400+4+1000+4+1000+1);expect([...out.subarray(26,30)]).toEqual([9,0x9c,1,0]);
  expect([...out.subarray(442,446)]).toEqual([2,0xe8,3,0]);expect([...out.subarray(1446,1450)]).toEqual([2,0xe8,3,0]);expect(out.at(-1)).toBe(0);
  expect(out.subarray(42,442)).toEqual(data.subarray(0,400));expect(out.subarray(1450,2450)).toEqual(data.subarray(1400,2400));
  // A short first packet (output -ss) gives blocks without one uniform span, which the demuxer refuses.
  await expect(openVoc(memoryInput(out),{maxReadBytes:4096})).rejects.toThrow('uniform');
  const empty=collectingOutput();await muxVoc(empty.output,{codec:'pcm_u8',channels:2,sampleRate:8000},chunks(data,2,[]),{maxWriteBytes:64,framing:{blockAlign:2,samplesPerPacket:1024n,sampleCount:0n}});
  expect(empty.bytes()).toEqual(concat(vocFileHeader(),Uint8Array.of(0)));
  const u8=collectingOutput();await muxVoc(u8.output,{codec:'pcm_u8',channels:2,sampleRate:8000},chunks(data,2,[6]),{maxWriteBytes:64,framing:{blockAlign:2,samplesPerPacket:2n,sampleCount:3n}});
  expect([...u8.bytes().subarray(26)]).toEqual([8,4,0,0,0x80,0xc1,0,1,1,6,0,0,0x83,0,...data.subarray(0,4),2,2,0,0,...data.subarray(4,6),0]);
});
it('aborts VOC output exactly once and honors cancellation',async()=>{
  const fail=async(packets:AsyncIterable<MediaPacket>,framing:{blockAlign:number;samplesPerPacket:bigint;sampleCount:bigint},signal?:AbortSignal)=>{
    let aborts=0,writes=0;const output={async write(){writes++;},async commit(){throw new Error('no commit');},async abort(){aborts++;}};
    await expect(muxVoc(output,{codec:'pcm_s16le',channels:1,sampleRate:8000},packets,{maxWriteBytes:64,framing,...(signal?{signal}:{})})).rejects.toThrow();
    expect(aborts).toBe(1);return writes;
  };
  expect(await fail(chunks(bytes(10),2,[10]),{blockAlign:2,samplesPerPacket:4n,sampleCount:6n})).toBeGreaterThan(0);
  expect(await fail(chunks(bytes(10),2,[10]),{blockAlign:4,samplesPerPacket:4n,sampleCount:5n})).toBe(0);
  expect(await fail(chunks(bytes(10),2,[10]),{blockAlign:2,samplesPerPacket:0n,sampleCount:5n})).toBe(0);
  const controller=new AbortController();controller.abort();expect(await fail(chunks(bytes(10),2,[10]),{blockAlign:2,samplesPerPacket:5n,sampleCount:5n},controller.signal)).toBe(0);
  let aborts=0;const output={async write(){throw new Error('disk');},async commit(){},async abort(){aborts++;throw new Error('abort');}};
  await expect(muxVoc(output,{codec:'pcm_s16le',channels:1,sampleRate:8000},chunks(bytes(10),2,[10]),{maxWriteBytes:64,framing:{blockAlign:2,samplesPerPacket:5n,sampleCount:5n}})).rejects.toThrow('VOC output and abort failed');expect(aborts).toBe(1);
});
it('registers the VOC descriptor with native names, codecs, span and seek refusal',async()=>{
  const format=containerFormat('voc')!;expect(format).toBe(voc);
  expect(voc.mux).toMatchObject({label:'VOC',extensions:['.voc'],defaultCodec:'pcm_s16le',dropsMetadata:true});expect('extensions' in voc.demux).toBe(false);
  expect(voc.mux.refuse()).toEqual(expect.objectContaining({message:'unsupported codec',exitCode:234}));
  const file=concat(header(),type9(8000,16,1,4,bytes(4096)),block(2,bytes(100)));
  const options={maxReadBytes:4096,signal:new AbortController().signal,declared:{sampleRate:44100,channels:1,guessLayout:true}};
  const input=await voc.demux.open(memoryInput(file),{...options,seek:0n});expect(voc.demux.packetSpan(input.info as never)).toBe(1024n);
  await expect(voc.demux.open(memoryInput(file),{...options,seek:1n})).rejects.toThrow('seeking');
  expect(()=>voc.mux.validate!({codec:'pcm_u8',channels:256,sampleRate:8000,channelMask:null,layoutMask:null,channelLayout:'',samples:0n,bitexact:true,options:[]})).toThrow('parameters');
});
