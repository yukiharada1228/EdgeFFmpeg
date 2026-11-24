import {expect,it} from 'vitest';
import {ExecutionError} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import {nistsphere,openNistSphere,probeNistSphere,readNistSphereHeader,nistSphereCodec,scanNistInteger,scanNistWord,isNistMetadata,NistSphereError} from '../../packages/containers/src/nistsphere.js';
import {memoryInput} from '../helpers/wav.js';
const text=(value:string)=>Uint8Array.from(value,c=>c.charCodeAt(0));
function sphere(lines:readonly string[],headerSize=128,data=new Uint8Array(0),eol='\n'):Uint8Array{
  const head=text(`NIST_1A\n${String(headerSize).padStart(7)}\n`+lines.map(line=>line+eol).join('')),bytes=new Uint8Array(Math.max(headerSize,head.length)+data.length).fill(0x20);
  bytes.set(head);bytes.set(data,Math.max(headerSize,head.length));return bytes;
}
const base=['channel_count -i 2','sample_n_bytes -i 2','sample_rate -i 8000'];
async function collect(input:Awaited<ReturnType<typeof openNistSphere>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
async function status(promise:Promise<unknown>):Promise<number|string>{try{await promise;return 'ok';}catch(error){return error instanceof ExecutionError?error.exitCode:error instanceof NistSphereError?error.code:String(error);}}
it('scans NIST SPHERE key lines with sscanf semantics',()=>{
  expect(scanNistInteger('channel_count -i 2')).toBe(2);expect(scanNistInteger('sample_rate\t-i\t+16000.5')).toBe(16000);expect(scanNistInteger('sample_n_bytes -i -1')).toBe(-1);
  expect(scanNistInteger('channel_count -i')).toBeNull();expect(scanNistInteger('channel_count -i x2')).toBeNull();expect(scanNistInteger('sample_count -i 0000000000000123',18)).toBe(123n);
  expect(()=>scanNistInteger('sample_rate -i 1234567890')).toThrow(/integers this long/);
  expect(scanNistWord('sample_coding -s3 pcm')).toBe('pcm');expect(scanNistWord(`sample_coding -s40 ${'a'.repeat(40)}`)).toBe('a'.repeat(31));expect(scanNistWord('sample_coding -s3')).toBeNull();
  // "%31s %*s %31s" == 2: a key longer than 31 bytes splits into the skipped token.
  expect(isNistMetadata('database_id -s5 TIMIT')).toBe(true);expect(isNistMetadata('database_id -s5')).toBe(false);expect(isNistMetadata('   ')).toBe(false);expect(isNistMetadata('')).toBe(false);
  expect(isNistMetadata(`${'k'.repeat(40)} value`)).toBe(true);expect(isNistMetadata(`${'k'.repeat(31)} value`)).toBe(false);
});
it('ports ff_get_line CR LF CRLF and NUL termination and the 255-byte line limit',async()=>{
  for(const eol of ['\n','\r','\r\n']){const header=await readNistSphereHeader(memoryInput(sphere([...base,'end_head'],128,new Uint8Array(0),eol)),{maxReadBytes:3});expect(header).toMatchObject({headerSize:128,channels:2,sampleRate:8000,bps:2,be:false,coding:'pcm',metadata:false});}
  const nul=await readNistSphereHeader(memoryInput(sphere([...base,'\0database_id -s5 TIMIT','end_head'],256)),{maxReadBytes:64});expect(nul.metadata).toBe(true);
  expect((await readNistSphereHeader(memoryInput(sphere([...base,'x'.repeat(255),'end_head'],512)),{maxReadBytes:64})).end).toBeGreaterThan(255);
  await expect(readNistSphereHeader(memoryInput(sphere([...base,'x'.repeat(256),'end_head'],512)),{maxReadBytes:64})).rejects.toThrow(/longer than 255 bytes/);
});
it('parses keys in native order with prefix matching and native statuses',async()=>{
  const header=await readNistSphereHeader(memoryInput(sphere(['channel_count -i 3','sample_byte_format -s2 10','sample_coding -s3 PCM','sample_count -i 99','sample_n_bytes -i 3','sample_rate -i 44100','sample_sig_bits -i 24','end_head_extra'],256)),{maxReadBytes:7});
  expect(header).toMatchObject({channels:3,be:true,coding:'PCM',sampleCount:99n,bps:3,sampleRate:44100,sigBits:24,metadata:false});expect(nistSphereCodec(header)).toEqual({codec:'pcm_s24be',bits:24});
  const codec=async(lines:string[])=>nistSphereCodec(await readNistSphereHeader(memoryInput(sphere([...lines,'end_head'],256)),{maxReadBytes:64})).codec;
  expect(await codec(['sample_n_bytes -i 1'])).toBe('pcm_s8');expect(await codec(['sample_n_bytes -i 4','sample_byte_format -s1 1'])).toBe('pcm_s32le');expect(await codec(['sample_n_bytes -i 2','sample_sig_bits -i 24'])).toBe('pcm_s24le');
  expect(await codec(['sample_n_bytes -i 1','sample_byte_format -s6 MU-LAW'])).toBe('pcm_mulaw');expect(await codec(['sample_n_bytes -i 1','sample_coding -s4 alaw'])).toBe('pcm_alaw');expect(await codec(['sample_n_bytes -i 1','sample_coding -s6 mu-law'])).toBe('pcm_mulaw');
  await expect(codec(['sample_n_bytes -i 2','sample_sig_bits -i 12'])).rejects.toThrow(/12 significant bits/);await expect(codec(['sample_n_bytes -i 2','sample_coding -s4 ulaw'])).rejects.toThrow(/companded/);
  await expect(codec(['sample_n_bytes -i 2','sample_coding -s20 pcm,embedded-shorten'])).rejects.toThrow(/Shorten/);await expect(codec(['sample_n_bytes -i 8'])).rejects.toThrow(/64-bit/);await expect(codec([])).rejects.toThrow(/0-bit/);
  const statusOf=(lines:string[],size=256,pad=true)=>{const bytes=sphere(lines,size);return status(readNistSphereHeader(memoryInput(pad?bytes:bytes.subarray(0,text(`NIST_1A\n${String(size).padStart(7)}\n`+lines.map(l=>l+'\n').join('')).length)),{maxReadBytes:64}));};
  expect(await statusOf([...base,'end_head'],0)).toBe(183);expect(await statusOf([...base,'end_head'],70)).toBe(183);expect(await statusOf(base,256,false)).toBe(187);
  expect(await statusOf(['channel_count -i 0','end_head'])).toBe(183);expect(await statusOf(['channel_count -i 32768','end_head'])).toBe(183);expect(await statusOf(['channel_count -i','end_head'])).toBe(183);
  expect(await statusOf(['sample_n_bytes -i 4096','end_head'])).toBe(183);expect(await statusOf(['sample_sig_bits -i 0','end_head'])).toBe(183);expect(await statusOf(['sample_byte_format -s4 0123','end_head'])).toBe(176);
  expect(await status(readNistSphereHeader(memoryInput(text('NIST_1A\nabc\n')),{maxReadBytes:64}))).toBe(183);
  expect(await status(readNistSphereHeader(memoryInput(sphere(Array.from({length:3000},()=>'pad -s1 x'),1<<20)),{maxReadBytes:64}))).toBe('unsupported');
});
it('opens the data range with bounded reads seeks and explicit refusals',async()=>{
  const pcm=Uint8Array.from({length:24},(_,i)=>i),bytes=sphere([...base,'sample_count -i 6','end_head'],128,pcm),requests:Array<{offset:bigint;length:number}>=[];
  const input=await openNistSphere(memoryInput(bytes,requests),{maxReadBytes:8});
  expect(input.info).toMatchObject({container:'nistsphere',codec:'pcm_s16le',channels:2,sampleRate:8000,channelMask:null,blockAlign:4,dataOffset:128n,headerSize:128n,dataBytes:24n,durationSamples:6n,sampleCount:6n,bitsPerCodedSample:16,metadata:false});
  expect(requests.every(request=>request.length<=8&&request.offset<128n)).toBe(true);
  requests.length=0;const packets=await collect(input,2n,8);expect(packets.map(packet=>[packet.pts,packet.duration,[...packet.data]])).toEqual([[2n,2n,[...pcm.subarray(8,16)]],[4n,2n,[...pcm.subarray(16,24)]]]);expect(requests.every(request=>request.offset>=136n)).toBe(true);
  const meta=await openNistSphere(memoryInput(sphere([...base,'database_id -s5 TIMIT','end_head'],128,pcm)),{maxReadBytes:64});expect(meta.info.metadata).toBe(true);
  await expect(openNistSphere(memoryInput(sphere([...base,'end_head'],128,pcm.subarray(1))),{maxReadBytes:64})).rejects.toThrow(/partial sample frame/);
  await expect(openNistSphere(memoryInput(sphere(base.slice(0,2).concat('end_head'),100,pcm)),{maxReadBytes:64})).rejects.toThrow(/sample_rate/);
  await expect(openNistSphere(memoryInput(sphere(base.slice(1).concat('end_head'),100,pcm)),{maxReadBytes:64})).rejects.toThrow(/channel_count/);
  await expect(openNistSphere(memoryInput(sphere([...base,'end_head'],128).subarray(0,120)),{maxReadBytes:64})).rejects.toThrow(/past EOF/);
  await expect(openNistSphere(memoryInput(sphere([...base,'sample_count -i 5','end_head'],128,pcm)),{maxReadBytes:64,seek:1n})).rejects.toThrow(/sample_count that differs/);
  expect((await openNistSphere(memoryInput(sphere([...base,'sample_count -i 6','end_head'],128,pcm)),{maxReadBytes:64,seek:1n})).info.durationSamples).toBe(6n);
  await expect(openNistSphere(memoryInput(bytes),{maxReadBytes:0})).rejects.toThrow(/read budget/);
});
it('probes NIST_1A with bounded reads and registers a demux-only descriptor',async()=>{
  const bytes=sphere([...base,'end_head'],128,new Uint8Array(8)),requests:Array<{offset:bigint;length:number}>=[];
  expect(await probeNistSphere(memoryInput(bytes,requests),3)).toBe(true);expect(requests.every(request=>request.length<=3)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(8);
  expect(await probeNistSphere(memoryInput(text('NIST_1B\n...')),64)).toBe(false);expect(await probeNistSphere(memoryInput(text('NIST_1A')),64)).toBe(false);
  expect(await detectAudioContainer(memoryInput(bytes),1)).toBe('nistsphere');
  expect(containerFormat('nistsphere')).toBe(nistsphere);expect(Object.hasOwn(nistsphere,'mux')).toBe(false);expect(Object.isFrozen(nistsphere)&&Object.isFrozen(nistsphere.demux)&&Object.isFrozen(nistsphere.demux.probe)).toBe(true);
  expect(nistsphere.demux).toMatchObject({headerBytes:512});expect(nistsphere.demux.probe.precedence).toBe(100);expect(nistsphere.demux.probe.head(text('NIST'))).toBe(true);expect(nistsphere.demux.probe.head(text('NISt'))).toBe(false);
});
it('aborts before and between bounded header reads',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));
  await expect(openNistSphere(memoryInput(sphere([...base,'end_head'])),{maxReadBytes:4,signal:controller.signal})).rejects.toThrow('stop');
  const late=new AbortController();let reads=0;const bytes=sphere([...base,'end_head']);
  const input={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){if(++reads===3)late.abort(new Error('late'));return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openNistSphere(input,{maxReadBytes:4,signal:late.signal})).rejects.toThrow('late');expect(reads).toBe(3);
});
