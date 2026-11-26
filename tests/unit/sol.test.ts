import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import {isSolHead,openSol,sol,solStream} from '../../packages/containers/src/sol.js';
import {memoryInput} from '../helpers/wav.js';
/** Independent of the module: u16le magic, "SOL\0", u16le rate, u8 type, u32le size, a padding byte unless magic 0x0B8D, then the payload. */
function file(magic:number,rate:number,type:number,payload:number,seed=1):Uint8Array{
  const offset=magic===0x0b8d?13:14,bytes=new Uint8Array(offset+payload),view=new DataView(bytes.buffer);
  view.setUint16(0,magic,true);bytes.set([0x53,0x4f,0x4c,0],2);view.setUint16(6,rate,true);bytes[8]=type;view.setUint32(9,payload,true);if(offset===14)bytes[13]=0xa5;
  for(let i=0;i<payload;i++)bytes[offset+i]=(i*(31+seed)+7*seed)&255;
  return bytes;
}
async function collect(input:Awaited<ReturnType<typeof openSol>>,start=0n,max?:number){const out:MediaPacket[]=[];for await(const packet of input.packets(start,max))out.push(packet);return out;}
it('ports sol_codec_id and sol_channels for the three magics and every type bit',()=>{
  for(let type=0;type<256;type++){
    expect(solStream(0x0b8d,type)).toEqual({codec:type&1?'sol_dpcm':'pcm_u8',channels:1});
    for(const magic of [0x0c0d,0x0c8d,0x1234])expect(solStream(magic,type)).toEqual({codec:type&1?'sol_dpcm':type&4?'pcm_s16le':'pcm_u8',channels:type&16?2:1});
  }
});
it('parses old and new headers with bounded reads and serves PCM from offset 13 or 14',async()=>{
  for(const [magic,type,codec,channels,offset,blockAlign] of [[0x0b8d,0x14,'pcm_u8',1,13n,1],[0x0c0d,0,'pcm_u8',1,14n,1],[0x0c8d,16,'pcm_u8',2,14n,2],[0x0c0d,4,'pcm_s16le',1,14n,2],[0x0c8d,20,'pcm_s16le',2,14n,4]] as const){
    const bytes=file(magic,22050,type,blockAlign*1000),requests:Array<{offset:bigint;length:number}>=[];
    const input=await openSol(memoryInput(bytes,requests),{maxReadBytes:4});
    expect(input.info).toMatchObject({container:'sol',codec,channels,sampleRate:22050,channelMask:null,blockAlign,dataOffset:offset,durationSamples:1000n,magic,type});
    expect(requests.every(request=>request.length<=4&&request.offset+BigInt(request.length)<=14n)).toBe(true);
    expect(sol.demux.packetSpan(input.info)).toBe(BigInt(4096/blockAlign));
    await expect(collect(input,0n,5)).rejects.toThrow('budget');const packets=await collect(await openSol(memoryInput(bytes),{maxReadBytes:4096}),0n,4096);expect(packets.reduce((sum,packet)=>sum+packet.data.length,0)).toBe(blockAlign*1000);
    expect([...packets[0]!.data.subarray(0,4)]).toEqual([...bytes.subarray(Number(offset),Number(offset)+4)]);expect(packets[0]!.timeBase).toEqual({num:1n,den:22050n});
  }
  // read_header never checks the magic: a declared input with another magic follows the new layout.
  expect((await openSol(memoryInput(file(0x1234,8000,4,64)),{maxReadBytes:64})).info).toMatchObject({codec:'pcm_s16le',dataOffset:14n,durationSamples:32n});
  expect((await openSol(memoryInput(file(0x0c0d,8000,0,0)),{maxReadBytes:64})).info.durationSamples).toBe(0n);
});
it('refuses DPCM, rate 0, a bad tag, truncation and partial trailing samples explicitly',async()=>{
  const open=(bytes:Uint8Array,maxReadBytes=64)=>openSol(memoryInput(bytes),{maxReadBytes});
  for(const [magic,type] of [[0x0b8d,1],[0x0c0d,1],[0x0c8d,5],[0x0c8d,17]] as const)await expect(open(file(magic,8000,type,64))).rejects.toThrow('SOL DPCM (sol_dpcm) decoding is not implemented');
  await expect(open(file(0x0c0d,0,4,64))).rejects.toMatchObject({code:'unsupported-command',exitCode:234,message:'Invalid SOL sample rate: 0'});
  for(const index of [2,3,4,5]){const bad=file(0x0c0d,8000,0,64);bad[index]=bad[index]!^1;await expect(open(bad)).rejects.toMatchObject({code:'unsupported-command',exitCode:255,message:'Invalid SOL tag'});}
  await expect(open(new Uint8Array(0))).rejects.toMatchObject({exitCode:255});await expect(open(Uint8Array.from([0x8d,0x0c,0x53]))).rejects.toMatchObject({exitCode:255});
  // Past EOF avio reads zeros, so "SOL" ending at byte 5 still matches the tag; such a header is then refused as truncated.
  await expect(open(Uint8Array.from([0x8d,0x0c,0x53,0x4f,0x4c]))).rejects.toThrow('Truncated SOL header');
  await expect(open(file(0x0c0d,8000,0,0).subarray(0,13))).rejects.toThrow('Truncated SOL header');await expect(open(file(0x0b8d,8000,0,0))).resolves.toBeDefined();
  await expect(open(file(0x0c0d,8000,4,65))).rejects.toThrow('partial trailing');await expect(open(file(0x0c8d,8000,20,66))).rejects.toThrow('partial trailing');await expect(open(file(0x0c8d,8000,16,3))).rejects.toThrow('partial trailing');
  await expect(open(file(0x0c0d,8000,0,4),0)).rejects.toThrow('budget');
  const short:ReadHandle={size:64n,async readAt(){return new Uint8Array(0);}};await expect(openSol(short,{maxReadBytes:64})).rejects.toThrow('read length');
});
it('checks the abort signal around every header read and packet read',async()=>{
  const bytes=file(0x0c8d,8000,20,8192),controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(openSol(memoryInput(bytes),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stopped');
  const live=new AbortController();let reads=0;
  const input:ReadHandle={size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===2)live.abort(new Error('mid-read'));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};
  await expect(openSol(input,{maxReadBytes:4,signal:live.signal})).rejects.toThrow('mid-read');
  const later=new AbortController(),opened=await openSol(memoryInput(bytes),{maxReadBytes:64,signal:later.signal}),iterator=opened.packets()[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);later.abort(new Error('packets'));await expect(iterator.next()).rejects.toThrow('packets');
});
it('probes the six bytes sol_probe reads and registers a demux-only descriptor',async()=>{
  for(const magic of [0x0b8d,0x0c0d,0x0c8d]){
    const bytes=file(magic,8000,0,16),requests:Array<{offset:bigint;length:number}>=[];
    expect(isSolHead(bytes.subarray(0,4))).toBe(true);expect(await detectAudioContainer(memoryInput(bytes,requests),2)).toBe('sol');
    expect(requests.every(request=>request.length<=2&&request.offset+BigInt(request.length)<=6n)).toBe(true);
  }
  for(const [index,value] of [[0,0x8e],[1,0x0d],[2,0x73],[3,0x6f],[4,0x6c],[5,1]] as const){
    const changed=file(0x0c0d,8000,0,16);changed[index]=value;expect(isSolHead(changed)).toBe(false);
    if(index<4)expect(sol.demux.probe.head(changed.subarray(0,4))).toBe(false);
    expect(await sol.demux.probe.confirm(memoryInput(changed),64)).toBe(false);
  }
  expect(await sol.demux.probe.confirm(memoryInput(file(0x0c0d,8000,0,0).subarray(0,5)),64)).toBe(false);
  expect(containerFormat('sol')).toBe(sol);expect(containerProbes).toContain(sol);
  expect(sol).toMatchObject({name:'sol',demux:{probe:{precedence:100},headerBytes:14}});expect('mux' in sol).toBe(false);expect('extensions' in sol.demux).toBe(false);expect(Object.isFrozen(sol.demux)&&Object.isFrozen(sol.demux.probe)).toBe(true);
});
it('demuxes through the PCM backend and refuses sol output, seeks and bad inputs before any output opens',async()=>{
  const files=new Map<string,Uint8Array>();let opens=0;
  const filesystem={
    async openRead(path:string):Promise<ReadHandle>{const bytes=files.get(path);if(!bytes)throw new Error(`missing ${path}`);return memoryInput(bytes);},
    async openWrite(path:string):Promise<WriteHandle>{opens++;const chunks:Uint8Array[]=[];return {async write(chunk){chunks.push(chunk.slice());},async commit(){files.set(path,Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));},async abort(){}};},
    async exists(path:string){return files.has(path);},async stat(path:string){const bytes=files.get(path);return bytes?{size:BigInt(bytes.length)}:null;}
  };
  const ffmpeg=new FFmpeg({filesystem:filesystem as never,backend:createMediaBackend(),budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:2000}});
  const input=file(0x0c8d,8000,20,4096*2+400);files.set('/in.sol',input);
  const copy=await ffmpeg.exec(['-i','/in.sol','-c:a','copy','-f','s16le','/out.raw']);expect(copy.exitCode,JSON.stringify(copy.diagnostics)).toBe(0);
  expect(Buffer.from(files.get('/out.raw')!).equals(Buffer.from(input.subarray(14)))).toBe(true);
  const crc=await ffmpeg.exec(['-i','/in.sol','-c:a','copy','-f','framecrc','/out.crc']);expect(crc.exitCode,JSON.stringify(crc.diagnostics)).toBe(0);
  expect(new TextDecoder().decode(files.get('/out.crc')).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,5).map(field=>Number(field)))).toEqual([[0,0,1024,4096],[1024,1024,1024,4096],[2048,2048,100,400]]);
  opens=0;
  for(const [name,bytes,message] of [['/dpcm.sol',file(0x0c0d,8000,1,64),'SOL DPCM (sol_dpcm) decoding is not implemented'],['/rate.sol',file(0x0c0d,0,0,64),'Invalid SOL sample rate: 0'],['/odd.sol',file(0x0c0d,8000,4,63),'SOL partial trailing sample frame is not implemented']] as const){
    files.set(name,bytes);const result=await ffmpeg.exec(['-i',name,'-f','s16le','/bad.raw']);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toBe(message);
  }
  const tag=file(0x0c0d,8000,0,64);tag[5]=1;files.set('/tag.sol',tag);const bad=await ffmpeg.exec(['-f','sol','-i','/tag.sol','-f','s16le','/bad.raw']);expect([bad.exitCode,bad.diagnostics.at(-1)?.message]).toEqual([255,'Invalid SOL tag']);
  const seek=await ffmpeg.exec(['-ss','0.001','-i','/in.sol','-f','s16le','/seek.raw']);expect([seek.diagnostics.at(-1)?.code,seek.diagnostics.at(-1)?.message]).toEqual(['unsupported-command','SOL input seeking is not implemented']);
  const muxed=await ffmpeg.exec(['-i','/in.sol','-f','sol','/out.sol']);expect(muxed.exitCode).not.toBe(0);expect(muxed.diagnostics.at(-1)?.message).toMatch(/Output requires/);
  expect(opens).toBe(0);
});
