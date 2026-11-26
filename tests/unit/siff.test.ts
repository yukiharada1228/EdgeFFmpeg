import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,VirtualFileSystem} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,detectAudioContainer} from '@edge-ffmpeg/containers';
import {matchesSiff,openSiff,probeSiff,siff} from '../../packages/containers/src/siff.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
/** Independent of the module: "SIFF" size "SOUN" "SHDR" be32(8) unknown rate(le16) bits(le16) "BODY" size, then u8 samples. */
function file(rate:number,bits:number,samples:number,edit?:(bytes:Uint8Array,view:DataView)=>void):Uint8Array{
  const bytes=new Uint8Array(36+samples),view=new DataView(bytes.buffer),ascii=(text:string,at:number)=>bytes.set([...text].map(c=>c.charCodeAt(0)),at);
  ascii('SIFF',0);ascii('SOUN',8);ascii('SHDR',12);view.setUint32(16,8,false);view.setUint16(24,rate,true);view.setUint16(26,bits,true);ascii('BODY',28);view.setUint32(32,0xffffffff,true);
  for(let i=0;i<samples;i++)bytes[36+i]=(i*37+11)&255;
  edit?.(bytes,view);return bytes;
}
const tag=(at:number,text:string)=>(bytes:Uint8Array)=>bytes.set([...text].map(c=>c.charCodeAt(0)),at);
async function collect(input:Awaited<ReturnType<typeof openSiff>>,start?:bigint,max?:number){const out:MediaPacket[]=[];for await(const packet of input.packets(start,max))out.push(packet);return out;}
it('parses the SOUN header with bounded reads that never touch the payload and derives the native packet span',async()=>{
  const bytes=file(11025,16,30000),requests:Array<{offset:bigint;length:number}>=[];
  const input=await openSiff(memoryInput(bytes,requests),{maxReadBytes:5});
  expect(input.info).toMatchObject({container:'siff',codec:'pcm_u8',channels:1,sampleRate:11025,channelMask:null,blockAlign:1,bitsPerSample:8,dataOffset:36n,dataBytes:30000n,durationSamples:30000n,bits:16,packetSamples:22050});
  expect(input.info.copyRefusal).toBe('SIFF stream copy of a short final packet is not implemented');
  expect(requests.every(request=>request.length<=5&&request.offset+BigInt(request.length)<=36n)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(36);
  expect(siff.demux.packetSpan(input.info)).toBe(22050n);
  for(const [rate,bits,span] of [[22050,8,22050],[8000,15,8000],[8000,16,16000],[11025,24,33075],[65535,65535,65535*8191]] as const){
    const opened=await openSiff(memoryInput(file(rate,bits,8)),{maxReadBytes:64});expect([opened.info.packetSamples,siff.demux.packetSpan(opened.info)]).toEqual([span,BigInt(span)]);
  }
  // Whole native packets and an empty BODY carry no copy refusal.
  expect((await openSiff(memoryInput(file(8000,8,16000)),{maxReadBytes:64})).info.copyRefusal).toBeUndefined();
  expect((await openSiff(memoryInput(file(8000,8,0)),{maxReadBytes:64})).info).toMatchObject({durationSamples:0n});expect((await openSiff(memoryInput(file(8000,8,0)),{maxReadBytes:64})).info.copyRefusal).toBeUndefined();
  requests.length=0;const packets=await collect(input,29990n,4);
  expect(packets.map(packet=>[packet.pts,packet.duration,packet.data.length])).toEqual([[29990n,4n,4],[29994n,4n,4],[29998n,2n,2]]);
  expect(Array.from(packets[0]!.data)).toEqual(Array.from(bytes.subarray(36+29990,36+29994)));expect(packets[0]!.timeBase).toEqual({num:1n,den:11025n});
  expect(requests.every(request=>request.offset>=36n+29990n)).toBe(true);
  await expect(collect(input,30001n)).rejects.toThrow('seek');
});
it('follows siff_read_header in its checks, order and native statuses',async()=>{
  const fail=async(bytes:Uint8Array,message:string,exitCode:number)=>{const error=await openSiff(memoryInput(bytes),{maxReadBytes:64}).catch((caught:unknown)=>caught) as {message:string;code:string;exitCode?:number};expect([error.message,error.code,error.exitCode??1],message).toEqual([message,'unsupported-command',exitCode]);};
  await fail(file(8000,8,10,tag(0,'SIFX')),'Invalid SIFF header',183);
  await fail(file(8000,8,10,tag(8,'VBV1')),'SIFF VBV1 video is not implemented',1);
  await fail(file(8000,8,10,tag(8,'SOUX')),'Not a VBV file',183);
  await fail(file(8000,8,10,tag(12,'shdr')),'Header chunk is missing',183);
  await fail(file(8000,8,10,(_,view)=>view.setUint32(16,8,true)),'Header chunk size is incorrect',183);
  // The BODY check follows the rate and bits reads and comes before the zero packet size.
  await fail(file(0,0,10,tag(28,'BOD ')),"'BODY' chunk is missing",183);
  // Reads past EOF see zeros, as avio does: a 20-byte file passes the size check and fails at BODY.
  await fail(file(8000,8,0).subarray(0,20),"'BODY' chunk is missing",183);await fail(file(8000,8,0).subarray(0,10),'Not a VBV file',183);await fail(new Uint8Array(0),'Invalid SIFF header',183);
  // The 'unknown' word, the SIFF and BODY sizes are ignored.
  expect((await openSiff(memoryInput(file(8000,8,10,(_,view)=>{view.setUint32(4,7,true);view.setUint32(20,0xdeadbeef,true);view.setUint32(32,1,true);})),{maxReadBytes:64})).info.durationSamples).toBe(10n);
  // Native opens these as empty streams; refused here.
  await expect(openSiff(memoryInput(file(8000,8,0).subarray(0,35)),{maxReadBytes:64})).rejects.toThrow('Truncated SIFF header');
  await expect(openSiff(memoryInput(file(8000,7,10)),{maxReadBytes:64})).rejects.toThrow('SIFF input with rate 8000 and 7 bits has no packets; not implemented');
  await expect(openSiff(memoryInput(file(0,16,10)),{maxReadBytes:64})).rejects.toThrow('SIFF input with rate 0 and 16 bits has no packets; not implemented');
  await expect(openSiff(memoryInput(file(8000,8,10)),{maxReadBytes:64,seek:1n})).rejects.toThrow('SIFF input seeking is not implemented');
  await expect(openSiff(memoryInput(file(8000,8,10)),{maxReadBytes:0})).rejects.toThrow('budget');await expect(probeSiff(memoryInput(file(8000,8,10)),0)).rejects.toThrow('budget');
  const short:ReadHandle={size:46n,async readAt(){return new Uint8Array(0);}};
  await expect(openSiff(short,{maxReadBytes:64})).rejects.toThrow('read length');
});
it('probes exactly the 12 bytes siff_probe inspects, detecting SOUN and VBV1',async()=>{
  for(const [edit,expected] of [[undefined,true],[tag(8,'VBV1'),true],[tag(8,'SOUX'),false],[tag(0,'SIFX'),false]] as const){
    const requests:Array<{offset:bigint;length:number}>=[],bytes=file(8000,8,100,edit);
    expect(await probeSiff(memoryInput(bytes,requests),3)).toBe(expected);expect(matchesSiff(bytes.subarray(0,12))).toBe(expected);
    expect(requests.every(request=>request.length<=3)).toBe(true);expect(requests.reduce((sum,request)=>sum+request.length,0)).toBe(12);
  }
  expect(await probeSiff(memoryInput(file(8000,8,0).subarray(0,11)),64)).toBe(false);expect(matchesSiff(new Uint8Array(4))).toBe(false);
  expect(await detectAudioContainer(memoryInput(file(8000,8,100)),64)).toBe('siff');expect(await detectAudioContainer(memoryInput(file(8000,8,100,tag(8,'VBV1'))),64)).toBe('siff');
  await expect(detectAudioContainer(memoryInput(file(8000,8,100,tag(8,'SOUX'))),64)).rejects.toThrow('Unsupported audio container signature');
  expect(siff.demux.probe.head(file(8000,8,0).subarray(0,4))).toBe(true);expect(siff.demux.probe.head(Uint8Array.from([0x52,0x49,0x46,0x46]))).toBe(false);
});
it('checks the abort signal around every read',async()=>{
  const bytes=file(8000,8,100),controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(openSiff(memoryInput(bytes),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stopped');
  await expect(probeSiff(memoryInput(bytes),64,controller.signal)).rejects.toThrow('stopped');
  const live=new AbortController();let reads=0;
  const input:ReadHandle={size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===3)live.abort(new Error('mid-read'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openSiff(input,{maxReadBytes:8,signal:live.signal})).rejects.toThrow('mid-read');
  const later=new AbortController(),opened=await openSiff(memoryInput(bytes),{maxReadBytes:64,signal:later.signal}),iterator=opened.packets(0n,8)[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);later.abort(new Error('later'));await expect(iterator.next()).rejects.toThrow('later');
});
it('registers a frozen demux-only descriptor and routes through the backend, refusing copy of a short tail before any output',async()=>{
  expect(containerFormat('siff')).toBe(siff);expect(containerFormat('siff')?.mux).toBeUndefined();expect(Object.isFrozen(siff)&&Object.isFrozen(siff.demux)&&Object.isFrozen(siff.demux.probe)).toBe(true);
  expect([siff.demux.probe.precedence,siff.demux.headerBytes,containerFormat('siff')?.demux?.extensions]).toEqual([100,36,undefined]);
  async function exec(input:Uint8Array,args:readonly string[]){
    const sink=collectingOutput();let opens=0;
    const filesystem:VirtualFileSystem={async openRead(){return memoryInput(input);},async openWrite(){opens++;return sink.output;}};
    const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(['-i','/in.son',...args]);
    return {result,opens,bytes:sink.bytes(),last:result.diagnostics.at(-1)};
  }
  const tail=file(8000,8,20000),even=file(8000,8,16000);
  const copy=await exec(tail,['-c:a','copy','-f','framecrc','/out.crc']);expect([copy.result.exitCode,copy.last?.code,copy.last?.message,copy.opens]).toEqual([1,'unsupported-command','SIFF stream copy of a short final packet is not implemented',0]);
  const decoded=await exec(tail,['-f','framecrc','/out.crc']);expect(decoded.result.exitCode).toBe(0);
  expect(new TextDecoder().decode(decoded.bytes).split('\n').filter(line=>line.startsWith('0,')).map(line=>line.split(',').slice(1,4).map(field=>Number(field.trim())))).toEqual([[0,0,8000],[8000,8000,8000],[16000,16000,4000]]);
  const raw=await exec(even,['-c:a','copy','-f','u8','/out.u8']);expect(raw.result.exitCode).toBe(0);expect(raw.bytes).toEqual(even.subarray(36));
  const vbv=await exec(file(8000,8,10,tag(8,'VBV1')),['-f','u8','/out.u8']);expect([vbv.result.exitCode,vbv.last?.message,vbv.opens]).toEqual([1,'SIFF VBV1 video is not implemented',0]);
  const body=await exec(file(8000,8,10,tag(28,'BODX')),['-f','u8','/out.u8']);expect([body.result.exitCode,body.last?.message,body.opens]).toEqual([183,"'BODY' chunk is missing",0]);
  const mux=await exec(even,['-f','siff','/out.son']);expect(mux.result.exitCode).not.toBe(0);expect(mux.last?.message).toMatch(/^Output requires /);expect(mux.opens).toBe(0);
});
