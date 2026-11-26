import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,VirtualFileSystem} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import {fsb,matchesFsb,openFsb,probeFsb} from '../../packages/containers/src/fsb.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
interface Fields {version?:string;count?:number;dataOffset?:number;duration?:number;format?:number;rate?:number;channels?:number}
/** Independent of the module: "FSB3", RL32@4 count, RL32@8 = data offset - 0x18, RL32@56 duration, RL32@72 format, RL32@76 rate, RL16@86 channels, filler elsewhere;
 * `payload` bytes follow byte 88 or the data offset, whichever is later. */
function file(fields:Fields={},payload=0):Uint8Array{
  const {version='3',count=1,dataOffset=0x80,duration=999,format=0x100,rate=24000,channels=2}=fields,start=Math.max(88,dataOffset),bytes=new Uint8Array(start+payload),view=new DataView(bytes.buffer);
  for(let i=8;i<bytes.length;i++)bytes[i]=(i*29+3)&255;
  bytes.set([0x46,0x53,0x42,version.charCodeAt(0)]);view.setUint32(4,count,true);view.setUint32(8,dataOffset-0x18,true);view.setUint32(56,duration,true);view.setUint32(72,format,true);view.setInt32(76,rate,true);view.setUint16(86,channels,true);
  return bytes;
}
async function collect(input:Awaited<ReturnType<typeof openFsb>>,start=0n,max?:number){const out:MediaPacket[]=[];for await(const packet of input.packets(start,max))out.push(packet);return out;}
async function run(input:Uint8Array,args:readonly string[]){
  const sink=collectingOutput();let opens=0;
  const filesystem:VirtualFileSystem={async openRead(){return memoryInput(input);},async openWrite(){opens++;return sink.output;}};
  const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args);
  return {result,opens,bytes:sink.bytes(),last:result.diagnostics.at(-1)};
}
it('reads the version 3 fields at their fsb_read_header offsets with bounded reads inside the 88-byte header',async()=>{
  for(const [channels,rate,format] of [[1,22050,0x100],[2,44100,0x00400100],[4,24000,0xffffffff],[6,8000,0x100]] as const){
    const bytes=file({channels,rate,format,duration:123456,dataOffset:0x200},channels*2*3000),requests:Array<{offset:bigint;length:number}>=[];
    const input=await openFsb(memoryInput(bytes,requests),{maxReadBytes:16});
    expect(input.info).toMatchObject({container:'fsb',codec:'pcm_s16le',channels,sampleRate:rate,channelMask:null,blockAlign:2*channels,dataOffset:0x200n,dataBytes:BigInt(channels*2*3000),format,headerDuration:123456n});
    expect(requests.every(request=>request.length<=16&&request.offset+BigInt(request.length)<=88n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(88);
    expect(fsb.demux.packetSpan()).toBe(2048n);
  }
  // The duration word is informational: packets run from the data offset to EOF.
  const bytes=file({channels:1,duration:5,dataOffset:88},8192),input=await openFsb(memoryInput(bytes),{maxReadBytes:4096});
  expect(input.info.durationSamples).toBe(4096n);expect(input.info.copyRefusal).toBeUndefined();
  const packets=await collect(input,0n,4096);expect(packets.reduce((sum,packet)=>sum+packet.data.length,0)).toBe(8192);
  expect([...packets[0]!.data.subarray(0,4)]).toEqual([...bytes.subarray(88,92)]);expect(packets[0]!.timeBase).toEqual({num:1n,den:24000n});
  expect((await collect(input,4000n,4096)).map(packet=>[packet.pts,packet.data.length])).toEqual([[4000n,192]]);
});
it('seeks backwards into the header for a data offset below 88, as avio_skip does',async()=>{
  for(const dataOffset of [0x18,0x40,86]){
    const bytes=file({channels:1,dataOffset},4096),input=await openFsb(memoryInput(bytes),{maxReadBytes:4096});
    expect(input.info).toMatchObject({dataOffset:BigInt(dataOffset),dataBytes:BigInt(bytes.length-dataOffset)});
    const data=Uint8Array.from((await collect(input,0n,4096)).flatMap(packet=>[...packet.data]));expect(Buffer.from(data).equals(Buffer.from(bytes.subarray(dataOffset)))).toBe(true);
  }
  // An offset of exactly the file size is an empty stream.
  const empty=file({dataOffset:88});expect((await openFsb(memoryInput(empty),{maxReadBytes:64})).info.durationSamples).toBe(0n);
});
it('flags a short final packet with copyRefusal and keeps whole-packet inputs copyable',async()=>{
  for(const [channels,frames,short] of [[1,2048,false],[2,4096,false],[4,0,false],[1,2049,true],[2,4095,true],[4,7,true]] as const){
    const info=(await openFsb(memoryInput(file({channels,dataOffset:88},frames*2*channels)),{maxReadBytes:4096})).info;
    expect(info.copyRefusal).toBe(short?'FSB stream copy of a short final packet (flagged corrupt natively) is not implemented':undefined);expect(Object.isFrozen(info)).toBe(true);
  }
});
it('refuses versions, formats, rates, channels, truncation, offsets and partial samples with native statuses where native fails',async()=>{
  const status=(promise:Promise<unknown>)=>promise.then(()=>null,(error:Error&{code?:string;exitCode?:number})=>[error.code,error.exitCode,error.message]);
  const open=(bytes:Uint8Array,maxReadBytes=64)=>status(openFsb(memoryInput(bytes),{maxReadBytes}));
  for(const version of ['1','2','5','X'])expect(await open(file({version},64))).toEqual(['unsupported-command',176,`FSB version ${version.charCodeAt(0)-48} is not supported`]);
  expect(await open(file({version:'4'},64))).toEqual(['unsupported',undefined,'FSB4 (XMA2 and THP) demuxing is not implemented']);
  for(const [format,codec] of [[0x00400000,'adpcm_ima_wav'],[0x00c00000,'adpcm_ima_wav'],[0x00800000,'adpcm_psx'],[0x02000000,'adpcm_thp']] as const)expect(await open(file({format},64))).toEqual(['unsupported',undefined,`FSB3 ${codec} decoding is not implemented`]);
  for(const format of [0,0xff,0x01000000])expect(await open(file({format},64))).toEqual(['unsupported-command',176,`Unsupported FSB format 0x${format.toString(16).toUpperCase()}`]);
  for(const rate of [0,-1,-2147483648])expect(await open(file({rate},64))).toEqual(['unsupported-command',183,'Invalid FSB sample rate']);
  expect(await open(file({channels:0},64))).toEqual(['unsupported-command',183,'Invalid FSB channel count']);
  // avio reads zeros past EOF: a cut before byte 86 always has zero channels; a cut at 87 keeps the low channel byte and is refused as truncated.
  for(const length of [0,3,8,60,79,86])expect((await open(file({},64).subarray(0,length)))?.slice(0,2)).toEqual(['unsupported-command',length<4?176:183]);
  const cut=file({channels:1}).subarray(0,87);expect(await open(cut)).toEqual(['unsupported',undefined,'Truncated FSB header is not implemented']);
  expect(await open(file({channels:513},1026))).toEqual(['unsupported',undefined,'FSB channel count above 512 is not implemented']);
  // From 2^30 Hz native decode timestamps leave the sample clock (audio_samplerate_update); refused after every native-status check.
  for(const rate of [1073741824,2147483647])expect(await open(file({rate},64))).toEqual(['unsupported',undefined,'FSB sample rates above 1073741823 are not implemented']);
  expect(await open(file({rate:1073741824,channels:0},64))).toEqual(['unsupported-command',183,'Invalid FSB channel count']);
  expect(await open(file({rate:1073741823},64))).toBeNull();
  expect(await open(file({dataOffset:0x10000}).subarray(0,200))).toEqual(['unsupported',undefined,'FSB data offset beyond the end of the file is not implemented']);
  expect(await open(file({channels:2,dataOffset:88},6))).toEqual(['unsupported',undefined,'FSB partial trailing sample frame is not implemented']);
  expect(await open(file({channels:1,dataOffset:87},4))).toEqual(['unsupported',undefined,'FSB partial trailing sample frame is not implemented']);
  await expect(openFsb(memoryInput(file()),{maxReadBytes:0})).rejects.toThrow('Invalid FSB read budget');
  await expect(openFsb(memoryInput(file({channels:4},64)),{maxReadBytes:7})).rejects.toThrow('read budget');
  const short:ReadHandle={size:200n,async readAt(){return new Uint8Array(0);}};await expect(openFsb(short,{maxReadBytes:64})).rejects.toThrow('Unexpected FSB header read length');
});
it('checks the abort signal around every header read and packet read',async()=>{
  const bytes=file({},8192),controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(openFsb(memoryInput(bytes),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stopped');
  await expect(probeFsb(memoryInput(bytes),64,controller.signal)).rejects.toThrow('stopped');
  const live=new AbortController();let reads=0;
  const input:ReadHandle={size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===2)live.abort(new Error('mid-read'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openFsb(input,{maxReadBytes:8,signal:live.signal})).rejects.toThrow('mid-read');expect(reads).toBe(2);
  const later=new AbortController(),opened=await openFsb(memoryInput(bytes),{maxReadBytes:64,signal:later.signal}),iterator=opened.packets()[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);later.abort(new Error('packets'));await expect(iterator.next()).rejects.toThrow('packets');
});
it('probes the eight bytes fsb_probe reads and registers a demux-only descriptor',async()=>{
  for(const version of ['1','3','4','5']){
    const bytes=file({version},16),requests:Array<{offset:bigint;length:number}>=[];
    expect(fsb.demux.probe.head(bytes.subarray(0,4))).toBe(true);expect(await detectAudioContainer(memoryInput(bytes,requests),3)).toBe('fsb');
    expect(requests.every(request=>request.length<=3&&request.offset+BigInt(request.length)<=8n)).toBe(true);
  }
  for(const version of ['0','6','X','a'])expect(fsb.demux.probe.head(file({version}).subarray(0,4))).toBe(false);
  for(const [index,value] of [[0,0x66],[1,0x73],[2,0x62]] as const){const changed=file();changed[index]=value;expect(fsb.demux.probe.head(changed.subarray(0,4))).toBe(false);}
  for(const count of [0,2,0x101,0x01000001])expect(await probeFsb(memoryInput(file({count})),64)).toBe(false);
  expect(matchesFsb(file())).toBe(true);expect(await probeFsb(memoryInput(file()),1)).toBe(true);
  // The probe buffer is zero-padded: a five-byte "FSB3\x01" still reads RL32@4 == 1.
  expect(await probeFsb(memoryInput(Uint8Array.from([0x46,0x53,0x42,0x33,1])),64)).toBe(true);expect(await probeFsb(memoryInput(Uint8Array.from([0x46,0x53,0x42,0x33])),64)).toBe(false);
  await expect(detectAudioContainer(memoryInput(file({count:2})),64)).rejects.toThrow(/^Unsupported audio container signature$/);
  expect(containerFormat('fsb')).toBe(fsb);expect(containerProbes).toContain(fsb);
  expect(fsb).toMatchObject({name:'fsb',demux:{probe:{precedence:100},headerBytes:88}});expect('mux' in fsb).toBe(false);expect('headerless' in fsb).toBe(false);
  expect('extensions' in fsb.demux).toBe(false);expect('seekBeyondEnd' in fsb.demux).toBe(false);expect(Object.isFrozen(fsb.demux)&&Object.isFrozen(fsb.demux.probe)).toBe(true);
});
it('demuxes through the PCM backend and refuses copy of short tails, fsb output, seeks and bad inputs before any output opens',async()=>{
  const pcm=Uint8Array.from({length:2*2048*2*2},(_,index)=>(index*131+7)&255),whole=file({channels:2,rate:24000,dataOffset:88},0);
  const input=Uint8Array.from([...whole,...pcm]),tail=Uint8Array.from([...input,1,2,3,4]);
  const reference=await run(pcm,['-f','s16le','-ar','24000','-ac','2','-i','/in.raw','/out.wav']);
  const decoded=await run(input,['-i','/in.fsb','/out.wav']);expect(decoded.result.exitCode,JSON.stringify(decoded.result.diagnostics)).toBe(0);expect(decoded.bytes).toEqual(reference.bytes);
  const copy=await run(input,['-f','fsb','-i','/in.fsb','-c:a','copy','-f','s16le','/out.raw']);expect(copy.result.exitCode).toBe(0);expect(copy.bytes).toEqual(pcm);
  const crc=await run(input,['-i','/in.fsb','-c:a','copy','-f','framecrc','/out.crc']);expect(crc.result.exitCode,JSON.stringify(crc.result.diagnostics)).toBe(0);
  expect(new TextDecoder().decode(crc.bytes).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,5).map(field=>Number(field)))).toEqual([[0,0,2048,8192],[2048,2048,2048,8192]]);
  const tailDecoded=await run(tail,['-i','/in.fsb','-c:a','pcm_s16le','-f','framecrc','/out.crc']);expect(tailDecoded.result.exitCode).toBe(0);
  expect(new TextDecoder().decode(tailDecoded.bytes).split('\n').filter(line=>/^0,/.test(line)).map(line=>Number(line.split(',')[3]))).toEqual([2048,2048,1]);
  for(const args of [['-c:a','copy','-f','framecrc','/out.crc'],['-c:a','copy','-f','s16le','/out.raw'],['-c:a','copy','/out.wav']]){
    const refused=await run(tail,['-i','/in.fsb',...args]);expect([refused.result.exitCode,refused.last?.code,refused.last?.message,refused.opens]).toEqual([1,'unsupported-command','FSB stream copy of a short final packet (flagged corrupt natively) is not implemented',0]);
  }
  const seek=await run(input,['-ss','0.001','-i','/in.fsb','-f','s16le','/out.raw']);expect([seek.last?.code,seek.last?.message,seek.opens]).toEqual(['unsupported-command','FSB input seeking is not implemented',0]);
  const version=await run(file({version:'1'},64),['-i','/in.fsb','/out.wav']);expect([version.result.exitCode,version.opens]).toEqual([176,0]);
  const rate=await run(file({rate:0},64),['-i','/in.fsb','/out.wav']);expect([rate.result.exitCode,rate.opens]).toEqual([183,0]);
  const adpcm=await run(file({format:0x00800000},64),['-i','/in.fsb','/out.wav']);expect(adpcm.result.exitCode).not.toBe(0);expect(adpcm.opens).toBe(0);
  const declared=await run(input,['-f','fsb','-ar','24000','-i','/in.fsb','/out.wav']);expect([declared.last?.message,declared.opens]).toEqual(['Input rate/channel declarations currently require a raw PCM format',0]);
  const muxed=await run(pcm,['-f','s16le','-i','/in.raw','-f','fsb','/out.fsb']);expect(muxed.result.exitCode).not.toBe(0);expect(muxed.opens).toBe(0);
});
