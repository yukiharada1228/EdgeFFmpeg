import {expect,it} from 'vitest';
import {containerFormat,outputContainerFor} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {caf,cafChannelLayout,muxCaf,supportsCafCodec,validateCafOutput} from '../../packages/containers/src/caf.js';
import type {CafCodec,CafOutputFormat} from '../../packages/containers/src/caf.js';
import {collectingOutput} from '../helpers/output.js';
/** [format id, flags, bits] per codec: ff_codec_caf_tags, cafenc.c codec_flags and av_get_bits_per_sample. */
const descs:Array<[CafCodec,string,number,number]>=[['pcm_s8','lpcm',0,8],['pcm_s16le','lpcm',2,16],['pcm_s16be','lpcm',0,16],['pcm_s24le','lpcm',2,24],['pcm_s24be','lpcm',0,24],['pcm_s32le','lpcm',2,32],['pcm_s32be','lpcm',0,32],
  ['pcm_f32le','lpcm',3,32],['pcm_f32be','lpcm',1,32],['pcm_f64le','lpcm',3,64],['pcm_f64be','lpcm',1,64],['pcm_alaw','alaw',0,8],['pcm_mulaw','ulaw',0,8]];
const text=(bytes:Uint8Array,offset:number,length=4)=>String.fromCharCode(...bytes.subarray(offset,offset+length));
const fmt=(fields:Partial<CafOutputFormat>={}):CafOutputFormat=>({codec:'pcm_s16be',channels:2,sampleRate:44100,layoutMask:3,bitexact:true,...fields});
async function mux(format:CafOutputFormat,payload:Uint8Array,maxWriteBytes=4096){
  const sink=collectingOutput(),blockAlign=format.channels*(descs.find(([codec])=>codec===format.codec)![3]/8),samples=payload.length/blockAlign;
  async function* packets():AsyncIterable<MediaPacket>{if(samples)yield {streamIndex:0,data:payload,pts:0n,dts:0n,duration:BigInt(samples),timeBase:{num:1n,den:BigInt(format.sampleRate)},flags:1};}
  await muxCaf(sink.output,format,packets(),{sampleCount:BigInt(samples),maxWriteBytes});
  return sink;
}
/** Walks the chunks after the 8-byte file header. */
function chunks(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),list:Array<{tag:string;size:bigint;offset:number}>=[];
  for(let offset=8;offset<bytes.length;){const tag=text(bytes,offset),size=view.getBigUint64(offset+4,false);list.push({tag,size,offset:offset+12});if(tag==='data')break;offset+=12+Number(size);}
  return list;
}
it('writes the caff v1 header and the 32-byte desc chunk for every supported codec',async()=>{
  for(const [codec,id,flags,bits]of descs)for(const [channels,sampleRate]of [[1,8000],[2,44100],[5,96000]] as const){
    const blockAlign=channels*bits/8,payload=new Uint8Array(blockAlign*3).map((_,i)=>i*7),sink=await mux(fmt({codec,channels,sampleRate,layoutMask:null}),payload);
    const bytes=sink.bytes(),view=new DataView(bytes.buffer);
    expect(text(bytes,0)).toBe('caff');expect([view.getUint16(4,false),view.getUint16(6,false)]).toEqual([1,0]);
    expect(text(bytes,8)).toBe('desc');expect(view.getBigUint64(12,false)).toBe(32n);
    expect(view.getFloat64(20,false)).toBe(sampleRate);expect(text(bytes,28)).toBe(id);
    expect([32,36,40,44,48].map(offset=>view.getUint32(offset,false))).toEqual([flags,blockAlign,1,channels,bits]);
    expect(text(bytes,52)).toBe('data');expect(view.getBigUint64(56,false)).toBe(BigInt(payload.length+4));expect(view.getUint32(64,false)).toBe(0);
    expect(bytes.length).toBe(68+payload.length);expect([...bytes.subarray(68)]).toEqual([...payload]);expect(sink.committed).toBe(true);
  }
  const view=new DataView((await mux(fmt({sampleRate:44100}),new Uint8Array(0))).bytes().buffer);expect(view.getBigUint64(20,false)).toBe(0x40e5888000000000n);
});
it('ports mov_channel_layout in table order and falls back to the channel bitmap',()=>{
  const named:Array<[number|bigint,number]>=[[0x4,0x00640001],[0x3,0x00650002],[0x103,0x00830003],[0x33,0x00840004],[0x603,0x00840004],[0x7,0x00710003],[0x107,0x00730004],[0x37,0x00750005],[0x607,0x00750005],
    [0x3f,0x00790006],[0x60f,0x00790006],[0x63f,0x00800008],[0x6cf,0x007e0008],[0x6000003f,0x00820008],[0xb,0x00850003],[0x10b,0x00860004],[0x3b,0x00870004],[0x60b,0x00870004],[0xf,0x00880004],[0x10f,0x00890005]];
  for(const [mask,tag]of named){expect(cafChannelLayout(mask)).toEqual([tag,0]);expect(cafChannelLayout(BigInt(mask))).toEqual([tag,0]);}
  for(const mask of [0x70f,0x1,0x2,0x8,0x30,0x13,0x80000000,185871])expect(cafChannelLayout(mask)).toEqual([0x10000,mask>>>0]);
  expect(cafChannelLayout(2164663779327n)).toEqual([0x10000,Number(2164663779327n&0xffffffffn)]);
});
it('writes the 12-byte chan chunk only for a native-order layout and the encoder info chunk unless bitexact',async()=>{
  for(const [mask,channels,tag,bitmap]of [[4,1,0x00640001,0],[3,2,0x00650002,0],[0xb,3,0x00850003,0],[0x3f,6,0x00790006,0],[0x70f,7,0x10000,0x70f],[null,3,0,0]] as const)for(const bitexact of [true,false]){
    const bytes=(await mux(fmt({channels,layoutMask:mask,bitexact}),new Uint8Array(channels*2*2))).bytes(),view=new DataView(bytes.buffer),list=chunks(bytes);
    expect(list.map(({tag})=>tag)).toEqual(['desc',...(mask===null?[]:['chan']),...(bitexact?[]:['info']),'data']);
    const chan=list.find(({tag})=>tag==='chan');if(chan){expect(chan.size).toBe(12n);expect([0,4,8].map(offset=>view.getUint32(chan.offset+offset,false))).toEqual([tag,bitmap,0]);}
    const info=list.find(({tag})=>tag==='info');
    if(info){expect(info.size).toBe(25n);expect(view.getUint32(info.offset,false)).toBe(1);expect(text(bytes,info.offset+4,21)).toBe('encoder\0Lavf63.1.102\0');}
    const data=list.at(-1)!;expect(data.size).toBe(BigInt(channels*4+4));expect(bytes.length).toBe(data.offset+4+channels*4);
    expect(bytes.length).toBeLessThanOrEqual(caf.mux.scratchBytes+channels*4);
  }
  expect(caf.mux.scratchBytes).toBe(8+44+24+37+16);
});
it('sizes the data chunk from the exact sample count and refuses invalid outputs before writing',()=>{
  expect(()=>validateCafOutput(fmt({channels:8,layoutMask:0x63f}),(1n<<58n))).not.toThrow();
  expect(()=>validateCafOutput(fmt({codec:'pcm_f64le',channels:65535,layoutMask:null}),(1n<<62n))).toThrow('64-bit size');
  for(const fields of [{channels:0},{channels:65536,layoutMask:null},{sampleRate:0},{sampleRate:2147483648},{sampleRate:44100.5}])expect(()=>validateCafOutput(fmt(fields),0n)).toThrow('Invalid CAF output parameters');
  expect(()=>validateCafOutput(fmt(),-1n)).toThrow('Invalid CAF output parameters');
  for(const layoutMask of [4,7,0,-1,0.5,0n])expect(()=>validateCafOutput(fmt({layoutMask}),0n)).toThrow('layout/count mismatch');
  for(const codec of ['pcm_u8','pcm_u16le','pcm_u16be','pcm_u24le','pcm_u24be','pcm_u32le','pcm_u32be'])expect(()=>validateCafOutput(fmt({codec:codec as never}),0n)).toThrow(expect.objectContaining({code:'unsupported-command',exitCode:183,message:`CAF muxer does not support ${codec}`}));
});
it('writes in chunks of at most maxWriteBytes',async()=>{
  for(const maxWriteBytes of [1,5,13,4096]){
    const payload=new Uint8Array(40).map((_,i)=>i),sink=await mux(fmt({bitexact:false}),payload,maxWriteBytes),reference=await mux(fmt({bitexact:false}),payload);
    expect(sink.lengths.every(length=>length<=maxWriteBytes)).toBe(true);expect(sink.bytes()).toEqual(reference.bytes());
  }
});
it('aborts CAF output exactly once and honors cancellation',async()=>{
  const sink=collectingOutput();let aborted=0;async function* packets():AsyncIterable<MediaPacket>{yield {streamIndex:0,data:new Uint8Array([1,2,3,4]),pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:8000n},flags:1};}
  await expect(muxCaf({...sink.output,async abort(reason){aborted++;await sink.output.abort(reason);}},fmt({sampleRate:8000}),packets(),{sampleCount:2n,maxWriteBytes:7})).rejects.toThrow();expect(aborted).toBe(1);expect(sink.committed).toBe(false);
  const refused=collectingOutput();let refusedAborts=0;
  await expect(muxCaf({...refused.output,async abort(reason){refusedAborts++;await refused.output.abort(reason);}},fmt({codec:'pcm_u8' as never}),packets(),{sampleCount:1n,maxWriteBytes:7})).rejects.toThrow('does not support');expect(refusedAborts).toBe(1);expect(refused.lengths).toEqual([]);
  const budget=collectingOutput();await expect(muxCaf(budget.output,fmt(),packets(),{sampleCount:1n,maxWriteBytes:0})).rejects.toThrow('write budget');expect(budget.aborted).toBe(true);
  const halted=new AbortController(),late=collectingOutput();halted.abort(new Error('halt'));
  await expect(muxCaf(late.output,fmt(),packets(),{sampleCount:1n,maxWriteBytes:7,signal:halted.signal})).rejects.toThrow('halt');expect(late.aborted).toBe(true);expect(late.lengths).toEqual([]);
});
it('registers the mux-only CAF descriptor with the native name, extension, default codec and refusal status',()=>{
  expect(containerFormat('caf')).toBe(caf);expect('demux' in caf).toBe(false);expect(outputContainerFor('/x/Out.CAF')).toBe(caf);
  expect(caf.mux).toMatchObject({label:'CAF',extensions:['.caf'],defaultCodec:'pcm_s16be'});expect('dropsMetadata' in caf.mux).toBe(false);expect('options' in caf.mux).toBe(false);
  expect(descs.every(([codec])=>supportsCafCodec(codec)&&caf.mux.supports(codec))).toBe(true);
  expect(['pcm_u8','pcm_u16le','pcm_u24le','pcm_u32be'].some(codec=>supportsCafCodec(codec))).toBe(false);
  expect(caf.mux.refuse!('pcm_u8')).toMatchObject({code:'unsupported-command',exitCode:183,message:'CAF muxer does not support pcm_u8'});
  expect(Object.isFrozen(caf)&&Object.isFrozen(caf.mux)&&Object.isFrozen(caf.mux.extensions)).toBe(true);
});
