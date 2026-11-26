import {expect,it} from 'vitest';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import {iff,iffPacketSpan,openIff,probeIff} from '../../packages/containers/src/iff.js';
import {memoryInput} from '../helpers/wav.js';
const latin=(text:string)=>Uint8Array.from(text,character=>character.charCodeAt(0));
const cat=(...parts:Uint8Array[])=>{const result=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;};
function chunk(id:string,data:Uint8Array,pad=true){const bytes=new Uint8Array(8+data.length+(pad?data.length&1:0));bytes.set(latin(id));new DataView(bytes.buffer).setUint32(4,data.length,false);bytes.set(data,8);return bytes;}
function mhdr({bits=8,num=8000,den=1,channels=1,compression=0,size=32}:{bits?:number;num?:number;den?:number;channels?:number;compression?:number;size?:number}={}){
  const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);
  if(size>=20){view.setUint16(4,bits,false);view.setUint32(8,num,false);view.setUint16(12,den,false);view.setUint16(16,channels,false);view.setUint16(18,compression,false);}
  return bytes;
}
function form(type:string,...chunks:Uint8Array[]){const body=cat(latin(type),...chunks),head=new Uint8Array(8);head.set(latin('FORM'));new DataView(head.buffer).setUint32(4,body.length,false);return cat(head,body);}
const payload=(length:number)=>Uint8Array.from({length},(_,index)=>(index*151+(index>>3)*17)&255);
const refusal=(exitCode:number)=>expect.objectContaining({code:'unsupported-command',exitCode});
const open=(bytes:Uint8Array,options:{maxReadBytes?:number;seek?:bigint}={},requests?:Array<{offset:bigint;length:number}>)=>openIff(memoryInput(bytes,requests),{maxReadBytes:options.maxReadBytes??4096,...(options.seek===undefined?{}:{seek:options.seek})});
it('walks MAUD chunks to EOF with bounded reads of chunk headers and the MHDR and CHAN fields only',async()=>{
  const bytes=form('MAUD',chunk('MHDR',mhdr({bits:16,num:44100,den:3,channels:2})),chunk('XTRA',payload(5)),chunk('MDAT',payload(4*300)),chunk('ZZZZ',payload(3))),requests:Array<{offset:bigint;length:number}>=[];
  const input=await open(bytes,{maxReadBytes:7},requests);
  expect(input.info).toMatchObject({container:'iff',codec:'pcm_s16be',channels:2,sampleRate:14700,channelMask:3,blockAlign:4,durationSamples:300n,dataOffset:BigInt(12+40+14+8),bits:16,compression:0,rateNum:44100,rateDen:3,metadata:false});
  // FORM header (12), then per chunk an 8-byte header; MHDR reads its first 20 bytes; MDAT and the skipped chunks are never read.
  const expected=[[0,12],[12,8],[20,20],[52,8],[66,8],[1274,8]].flatMap(([offset,length])=>{const parts=[];for(let at=0;at<length!;at+=7)parts.push({offset:BigInt(offset!+at),length:Math.min(7,length!-at)});return parts;});
  expect(requests).toEqual(expected);
  const packets=[];for await(const packet of input.packets(298n))packets.push([packet.pts,[...packet.data]]);
  const at=Number(input.info.dataOffset);expect(packets).toEqual([[298n,[...bytes.subarray(at+1192,at+1196)]],[299n,[...bytes.subarray(at+1196,at+1200)]]]);
  expect(iffPacketSpan()).toBe(8192n);
});
it('maps MAUD bits and compression to the four native PCM codecs and refuses the rest with 176',async()=>{
  for(const [bits,compression,codec]of [[8,0,'pcm_u8'],[16,0,'pcm_s16be'],[8,2,'pcm_alaw'],[8,3,'pcm_mulaw']] as const){
    const input=await open(form('MAUD',chunk('MHDR',mhdr({bits,compression,channels:3})),chunk('MDAT',payload(bits/8*3*5))));
    expect(input.info).toMatchObject({codec,channels:3,durationSamples:5n,blockAlign:bits/8*3});
  }
  for(const [bits,compression]of [[8,1],[16,2],[16,3],[24,0],[4,0],[8,4],[0,0]] as const)await expect(open(form('MAUD',chunk('MHDR',mhdr({bits,compression})),chunk('MDAT',payload(8))))).rejects.toEqual(refusal(176));
});
it('ports the MHDR arithmetic: integer num/den rate, zero denominator and channels refused with 183',async()=>{
  const rate=async(num:number,den:number)=>(await open(form('MAUD',chunk('MHDR',mhdr({num,den})),chunk('MDAT',payload(2))))).info.sampleRate;
  expect([await rate(8000,1),await rate(44100,3),await rate(22050,4),await rate(4294967295,65535),await rate(11025,2)]).toEqual([8000,14700,5512,65537,5512]);
  await expect(open(form('MAUD',chunk('MHDR',mhdr({den:0})),chunk('MDAT',payload(2))))).rejects.toEqual(refusal(183));
  await expect(open(form('MAUD',chunk('MHDR',mhdr({channels:0})),chunk('MDAT',payload(2))))).rejects.toEqual(refusal(183));
  await expect(open(form('MAUD',chunk('MHDR',mhdr({size:31})),chunk('MDAT',payload(2))))).rejects.toEqual(refusal(183));
  await expect(open(form('MAUD',chunk('MDAT',payload(2))))).rejects.toEqual(refusal(183));
  await expect(open(form('MAUD',chunk('MHDR',mhdr({num:3,den:4})),chunk('MDAT',payload(2))))).rejects.toThrow('sample rate 0');
  await expect(open(form('MAUD',chunk('MHDR',mhdr({num:4294967295})),chunk('MDAT',payload(2))))).rejects.toThrow('sample rate 4294967295');
  await expect(open(form('MAUD',chunk('MHDR',mhdr({channels:513})),chunk('MDAT',payload(513))))).rejects.toThrow('exceeds 512');
});
it('applies CHAN overrides in chunk order and flags metadata chunks',async()=>{
  const chan=(value:number)=>{const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value,false);return chunk('CHAN',bytes);};
  const channels=async(...chunks:Uint8Array[])=>(await open(form('MAUD',...chunks,chunk('MDAT',payload(12))))).info.channels;
  expect(await channels(chunk('MHDR',mhdr({channels:3})),chan(5))).toBe(1);
  expect(await channels(chunk('MHDR',mhdr({channels:1})),chan(6))).toBe(2);
  expect(await channels(chunk('MHDR',mhdr({channels:3})),chan(0xffffffff))).toBe(2);
  expect(await channels(chunk('MHDR',mhdr({channels:3})),chan(6),chunk('MHDR',mhdr({channels:4})))).toBe(4);
  // MHDR 1/2 channels and every CHAN override are native-order mono/stereo (masks 0x4/0x3); 3 or more channels stay unspecified (null).
  const mask=async(...chunks:Uint8Array[])=>(await open(form('MAUD',...chunks,chunk('MDAT',payload(12))))).info.channelMask;
  expect([await mask(chunk('MHDR',mhdr({channels:1}))),await mask(chunk('MHDR',mhdr({channels:2}))),await mask(chunk('MHDR',mhdr({channels:3}))),await mask(chunk('MHDR',mhdr({channels:3})),chan(5)),await mask(chunk('MHDR',mhdr({channels:1})),chan(6))]).toEqual([4,3,null,4,3]);
  await expect(open(form('MAUD',chan(6),chunk('MHDR',mhdr()),chunk('MDAT',payload(2))))).rejects.toEqual(refusal(183));
  await expect(open(form('MAUD',chunk('MHDR',mhdr()),chunk('CHAN',payload(3)),chunk('MDAT',payload(2))))).rejects.toEqual(refusal(183));
  for(const id of ['ANNO','TEXT','AUTH','(c) ','NAME'])expect((await open(form('MAUD',chunk('MHDR',mhdr()),chunk(id,latin('x')),chunk('MDAT',payload(2))))).info.metadata,id).toBe(true);
  expect((await open(form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(2)),chunk('NAME',new Uint8Array(0))))).info.metadata).toBe(true);
  // Later MDAT chunks replace earlier ones, as body_pos/body_end are reassigned.
  const last=await open(form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(4)),chunk('MDAT',payload(6))));expect(last.info).toMatchObject({durationSamples:6n,dataOffset:BigInt(12+40+12+8)});
});
it('refuses everything outside FORM MAUD PCM before any packet',async()=>{
  const valid=[chunk('MHDR',mhdr()),chunk('MDAT',payload(3))];
  await expect(open(form('8SVX',...valid))).rejects.toThrow('"8SVX"');
  for(const type of ['16SV','ILBM','ANIM','AIFF','DSD '])await expect(open(form(type,...valid))).rejects.toThrow('MAUD only');
  const frm8=form('MAUD',...valid);frm8.set(latin('FRM8'));await expect(open(frm8)).rejects.toThrow('FRM8');
  for(const id of ['VHDR','BODY','BMHD','CMAP','PROP','DSD '])await expect(open(form('MAUD',chunk('MHDR',mhdr()),chunk(id,payload(20)),chunk('MDAT',payload(3))))).rejects.toThrow(`"${id}" chunk in a MAUD form`);
  const beyond=form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(10)));await expect(open(beyond.subarray(0,beyond.length-1))).rejects.toThrow('MDAT chunk beyond EOF');
  const skipped=form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(10)),chunk('XTRA',payload(10)));await expect(open(skipped.subarray(0,skipped.length-1))).rejects.toThrow('"XTRA" chunk beyond EOF');
  await expect(open(cat(form('MAUD',...valid),latin('MDAT')))).rejects.toThrow('partial chunk header');
  await expect(open(form('MAUD',chunk('MHDR',mhdr({channels:2})),chunk('MDAT',payload(3))))).rejects.toThrow('partial sample frame');
  await expect(open(form('MAUD',chunk('MHDR',mhdr({bits:16})),chunk('MDAT',payload(3))))).rejects.toThrow('partial sample frame');
  await expect(open(form('MAUD',chunk('MHDR',mhdr())))).rejects.toThrow('without an MDAT');
  await expect(open(form('MAUD',...valid),{seek:1n})).rejects.toThrow('seek');
  await expect(open(latin('FORM\0\0\0\0MAU'))).rejects.toThrow('shorter');
  await expect(open(form('MAUD',...valid),{maxReadBytes:0})).rejects.toThrow('read budget');
  // An odd MDAT that ends the file without its pad byte is accepted, as native's pad skip runs past EOF.
  const odd=form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(101),false));expect((await open(odd)).info.durationSamples).toBe(101n);
  expect((await open(form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',new Uint8Array(0))))).info.durationSamples).toBe(0n);
});
it('probes FORM MAUD before aiff and leaves AIFF, AIFC and a bare FORM to aiff',async()=>{
  const maud=form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(4)));
  expect(await detectAudioContainer(memoryInput(maud),3)).toBe('iff');
  for(const type of ['AIFF','AIFC','8SVX','16SV'])expect(await probeIff(memoryInput(form(type,chunk('COMM',payload(18)))),64)).toBe(false);
  for(const bytes of [latin('FORM'),latin('FORM\0\0\0\0MAU'),latin('FORM\0\0\0\0')]){const requests:Array<{offset:bigint;length:number}>=[];expect(await probeIff(memoryInput(bytes,requests),64)).toBe(false);expect(requests).toEqual([]);}
  expect(await detectAudioContainer(memoryInput(latin('FORM')),64)).toBe('aiff');expect(await detectAudioContainer(memoryInput(form('AIFF',chunk('COMM',payload(18)))),64)).toBe('aiff');
  const requests:Array<{offset:bigint;length:number}>=[];expect(await probeIff(memoryInput(maud,requests),5)).toBe(true);expect(requests).toEqual([{offset:0n,length:5},{offset:5n,length:5},{offset:10n,length:2}]);
  expect(iff.demux.probe.head(latin('FORM'))).toBe(true);expect(iff.demux.probe.head(latin('FRM8'))).toBe(false);
  // nsp_probe scores 100 on 'DS16' at byte 4 as well: native's probe tie detects nothing, so iff does not claim that head.
  const tie=maud.slice();tie.set(latin('DS16'),4);expect(await probeIff(memoryInput(tie),64)).toBe(false);
  await expect(probeIff(memoryInput(maud),0)).rejects.toThrow('read budget');
});
it('honors cancellation and registers the demux-only descriptor',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(openIff(memoryInput(form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(4)))),{maxReadBytes:8,signal:controller.signal})).rejects.toThrow('stop');
  await expect(probeIff(memoryInput(form('MAUD')),8,controller.signal)).rejects.toThrow('stop');
  const late=new AbortController(),bytes=form('MAUD',chunk('MHDR',mhdr()),chunk('MDAT',payload(4)));
  const input={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){if(offset>=12n)late.abort(new Error('late'));return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openIff(input,{maxReadBytes:64,signal:late.signal})).rejects.toThrow('late');
  expect(containerFormat('iff')).toBe(iff);expect('mux' in iff).toBe(false);
  expect(iff.demux).toMatchObject({headerBytes:32,probe:{precedence:26}});expect('extensions' in iff.demux).toBe(false);
  expect(Object.isFrozen(iff)&&Object.isFrozen(iff.demux)).toBe(true);
});
