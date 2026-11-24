import {expect,it} from 'vitest';
import {ExecutionError} from '@edge-ffmpeg/core';
import {containerFormat,containerProbes,detectAudioContainer,inputContainerFor,outputContainerFor} from '@edge-ffmpeg/containers';
import {openPvf,pvf,pvfGetLine,pvfScanInts} from '../../packages/containers/src/pvf.js';
import {memoryInput} from '../helpers/wav.js';
const bytes=(text:string,data:number[]=[])=>new Uint8Array([...Buffer.from(text,'latin1'),...data]);
async function collect(input:Awaited<ReturnType<typeof openPvf>>,start=0n,max?:number){const result=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
it('ports ff_get_line terminators truncation CR lookahead and pending windows',()=>{
  // Native stores the LF or CR terminator in the buffer while it fits; NUL and EOF store nothing.
  expect(pvfGetLine(bytes('1 8000 16\nzz'),true)).toEqual({line:'1 8000 16\n',consumed:10});
  expect(pvfGetLine(bytes('1 8000 16\r\nzz'),true)).toEqual({line:'1 8000 16\r',consumed:11});
  expect(pvfGetLine(bytes('1 8000 16\rzz'),true)).toEqual({line:'1 8000 16\r',consumed:10});
  expect(pvfGetLine(bytes('1 8000 16\r\r'),true)).toEqual({line:'1 8000 16\r',consumed:10});
  expect(pvfGetLine(bytes('1 8000 16\r'),true)).toEqual({line:'1 8000 16\r',consumed:10});
  expect(pvfGetLine(bytes('1 8000 16\r'),false)).toEqual({line:'1 8000 16\r',consumed:null});
  expect(pvfGetLine(bytes('1 8000 16\0\n'),true)).toEqual({line:'1 8000 16',consumed:10});
  expect(pvfGetLine(bytes('1 8000 16'),true)).toEqual({line:'1 8000 16',consumed:9});
  expect(pvfGetLine(bytes('1 8000 16'),false)).toEqual({line:'1 8000 16',consumed:null});
  expect(pvfGetLine(bytes(''),true)).toEqual({line:'',consumed:0});
  const long='x'.repeat(40)+'\n';expect(pvfGetLine(bytes(long),true)).toEqual({line:'x'.repeat(31),consumed:41});
  expect(pvfGetLine(bytes('abcdef\n'),true,4)).toEqual({line:'abc',consumed:7});
});
it('ports the sscanf %d %d %d subset with C whitespace signs and conversion counts',()=>{
  expect(pvfScanInts('1 8000 16')).toEqual({count:3,values:[1n,8000n,16n]});
  expect(pvfScanInts(' \t1\v\f8000  16 99 abc')).toEqual({count:3,values:[1n,8000n,16n]});
  expect(pvfScanInts('+1+8000-16')).toEqual({count:3,values:[1n,8000n,-16n]});
  expect(pvfScanInts('01 08000 016')).toEqual({count:3,values:[1n,8000n,16n]});
  expect(pvfScanInts('1 0x1f40 16')).toEqual({count:2,values:[1n,0n]});
  expect(pvfScanInts('1 8000 +-16')).toEqual({count:2,values:[1n,8000n]});
  expect(pvfScanInts('1 8000')).toEqual({count:2,values:[1n,8000n]});
  expect(pvfScanInts('   ')).toEqual({count:-1,values:[]});
  expect(pvfScanInts('')).toEqual({count:-1,values:[]});
  expect(pvfScanInts('x')).toEqual({count:0,values:[]});
  expect(pvfScanInts('1 8000 1234567890123456789016').values[2]).toBe(1234567890123456789016n);
});
it('parses PVF headers into signed big-endian PCM with bounded reads and exact seeks',async()=>{
  for(const [bps,codec]of [[8,'pcm_s8'],[16,'pcm_s16be'],[24,'pcm_s24be'],[32,'pcm_s32be']] as const){
    const data=Array.from({length:3*2*bps/8},(_,i)=>i),file=bytes(`PVF1\n2 8000 ${bps}\r\n`,data),requests:Array<{offset:bigint;length:number}>=[];
    const input=await openPvf(memoryInput(file,requests),{maxReadBytes:8});
    expect(input.info).toMatchObject({container:'pvf',codec,channels:2,sampleRate:8000,channelMask:null,blockAlign:bps/4,dataOffset:BigInt(file.length-data.length),durationSamples:3n,headerLine:`2 8000 ${bps}\r`});
    expect(requests.every(request=>request.length<=8&&request.offset>=5n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBeLessThanOrEqual(123);
    const packets=await collect(input,1n);expect(packets[0]!.pts).toBe(1n);expect(packets.flatMap(packet=>[...packet.data])).toEqual(data.slice(bps/4));await expect(collect(input,4n)).rejects.toThrow('seek');
  }
  const empty=await openPvf(memoryInput(bytes('PVF1\n1 8000 16')),{maxReadBytes:3});expect(empty.info).toMatchObject({durationSamples:0n,dataOffset:14n});
  const one=await openPvf(memoryInput(bytes('PVF1\n1 1 8\r',[10])),{maxReadBytes:1});expect(one.info).toMatchObject({durationSamples:0n,dataOffset:12n});
  const kept=await openPvf(memoryInput(bytes('PVF1\n1 1 8\r',[9])),{maxReadBytes:1});expect(kept.info).toMatchObject({durationSamples:1n,dataOffset:11n});
  const unchecked=await openPvf(memoryInput(bytes('XXXX\n1 1 8\n',[1,2])),{maxReadBytes:64});expect(unchecked.info.durationSamples).toBe(2n);
});
it('refuses native INVALIDDATA headers with exit 183 and unmirrored ones explicitly',async()=>{
  for(const line of ['1 8000\n','0 8000 16\n','513 8000 16\n','1 0 16\n','1 -1 16\n','1 8000 0\n','1 8000 4194304\n','1 0x1f40 16\n','\n',' '.repeat(35)+'1 8000 16\n']){
    const error=await openPvf(memoryInput(bytes(`PVF1\n${line}`,[0,0])),{maxReadBytes:16}).catch(error=>error);
    expect(error,line).toBeInstanceOf(ExecutionError);expect(error.exitCode,line).toBe(183);
  }
  expect((await openPvf(memoryInput(bytes('PV')),{maxReadBytes:16}).catch(error=>error)).exitCode).toBe(183);
  expect((await openPvf(memoryInput(bytes('PVF1\n512 1 8\n',[])),{maxReadBytes:512})).info.channels).toBe(512);
  expect((await openPvf(memoryInput(bytes('PVF1\n1 1 4194296\n',[])),{maxReadBytes:16}).catch(error=>error)).message).toContain('4194296 bits');
  const refusals:Array<[string,number,string]>=[['1 8000 12\n',2,'12 bits per sample'],['1 8000 64\n',8,'pcm_s64be'],['1 8000 40\n',5,'40 bits'],['1 8000 7\n',1,'7 bits'],['1 4294975296 16\n',2,'32-bit int range'],['1 8000 -2147483649\n',2,'32-bit int range'],['2 8000 16\n',3,'Partial trailing'],['1 8000 16'+' '.repeat(130)+'\n',2,'header line extending past byte 128']];
  for(const [line,data,message]of refusals){const error=await openPvf(memoryInput(bytes(`PVF1\n${line}`,new Array(data).fill(0))),{maxReadBytes:16}).catch(error=>error);expect(error,line).not.toBeInstanceOf(ExecutionError);expect(error.message,line).toContain(message);}
  expect((await openPvf(memoryInput(bytes('PVF1\n1 8000 16'+' '.repeat(113)+'\n',[0,0])),{maxReadBytes:16})).info.dataOffset).toBe(128n);
  await expect(openPvf(memoryInput(bytes('PVF1\n1 8000 16\n')),{maxReadBytes:0})).rejects.toThrow('read budget');
  await expect(openPvf({size:20n,async readAt(){return new Uint8Array(0);}},{maxReadBytes:8})).rejects.toThrow('read length');
});
it('honors cancellation before and between PVF header reads',async()=>{
  const before=new AbortController();before.abort(new Error('stop'));await expect(openPvf(memoryInput(bytes('PVF1\n1 8000 16\n')),{maxReadBytes:8,signal:before.signal})).rejects.toThrow('stop');
  const during=new AbortController(),file=bytes('PVF1\n1 8000 16\n',[0,0]);let reads=0;
  await expect(openPvf({size:BigInt(file.length),async readAt(offset,length){reads++;during.abort(new Error('mid'));return file.slice(Number(offset),Number(offset)+length);}},{maxReadBytes:2,signal:during.signal})).rejects.toThrow('mid');expect(reads).toBe(1);
});
it('registers a demux-only pvf descriptor probing PVF1 newline with a five-byte confirm',async()=>{
  const descriptor=containerFormat('pvf')!;expect(descriptor).toBe(pvf);expect(descriptor.mux).toBeUndefined();expect(descriptor.headerless).toBeUndefined();
  expect(descriptor.demux).toMatchObject({headerBytes:128,probe:{precedence:100}});expect(descriptor.demux!.extensions).toBeUndefined();expect(descriptor.demux!.seekBeyondEnd).toBeUndefined();expect(descriptor.demux!.packetSpan).toBeUndefined();
  expect(containerProbes.some(format=>format.name==='pvf')).toBe(true);expect(inputContainerFor('/a.pvf')).toBeUndefined();expect(outputContainerFor('/a.pvf')).toBeUndefined();
  const requests:Array<{offset:bigint;length:number}>=[];expect(await detectAudioContainer(memoryInput(bytes('PVF1\n1 8000 16\n',[0,0]),requests),2)).toBe('pvf');expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(9);expect(requests.every(request=>request.length<=2&&request.offset<5n)).toBe(true);
  await expect(detectAudioContainer(memoryInput(bytes('PVF1\r\n1 8000 16\n')),8)).rejects.toThrow('Unsupported audio container signature');
  await expect(detectAudioContainer(memoryInput(bytes('PVF1')),8)).rejects.toThrow('Unsupported audio container signature');
  const opened=await pvf.demux.open(memoryInput(bytes('PVF1\n1 8000 16\n',[1,2])),{maxReadBytes:8,signal:new AbortController().signal,declared:{channels:1,sampleRate:44100,guessLayout:true},seek:0n});expect(opened.info).toMatchObject({codec:'pcm_s16be',durationSamples:1n});
});
