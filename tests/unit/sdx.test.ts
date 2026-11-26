import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,containerProbes,detectAudioContainer} from '@edge-ffmpeg/containers';
import {openSdx,scanSdxMarker,sdx,sdxCodec} from '../../packages/containers/src/sdx.js';
import {memoryInput} from '../helpers/wav.js';
/** Independent of the module: 'SDX:', free text, 0x1a, version, name length, name, 4 bytes, depth, RL32 rate, 16 bytes, then PCM. */
function sdxFile(o:{depth?:number;rate?:number;name?:number;text?:string;version?:number;samples?:number;extra?:number}={}):Uint8Array{
  const {depth=16,rate=22050,name=3,text='',version=1,samples=10,extra=0}=o,head=[...'SDX:'].map(c=>c.charCodeAt(0)),pre=[...text].map(c=>c.charCodeAt(0));
  const fixed=[0x1a,version,name,...Array.from({length:name},(_,i)=>0x41+i%26),9,9,9,9,depth,rate&255,(rate>>>8)&255,(rate>>>16)&255,(rate>>>24)&255,...new Array(16).fill(7)];
  const data=Array.from({length:samples*Math.max(1,depth>>3)+extra},(_,i)=>(i*151+(i>>3)*7+11)&255);
  return Uint8Array.from([...head,...pre,...fixed,...data]);
}
async function collect(input:Awaited<ReturnType<typeof openSdx>>,start?:bigint,max?:number){const out:MediaPacket[]=[];for await(const packet of input.packets(start,max))out.push(packet);return out;}
const refusal=(exitCode:number,message:string)=>expect.objectContaining({code:'unsupported-command',exitCode,message});
it('maps the four depths and nothing else to unsigned little-endian PCM',()=>{
  expect([8,16,24,32].map(sdxCodec)).toEqual(['pcm_u8','pcm_u16le','pcm_u24le','pcm_u32le']);
  for(const depth of [0,1,7,12,20,31,33,64,255,8.5])expect(sdxCodec(depth)).toBeNull();
});
it('scans for 0x1a in bounded reads and parses the header without reading the payload',async()=>{
  for(const [depth,codec] of [[8,'pcm_u8'],[16,'pcm_u16le'],[24,'pcm_u24le'],[32,'pcm_u32le']] as const)for(const budget of [1,2,3,4,64].filter(value=>value>=depth/8))for(const name of [0,1,255]){
    const text='free text before the marker'.repeat(4),bytes=sdxFile({depth,rate:44100,name,text,samples:7}),requests:Array<{offset:bigint;length:number}>=[];
    const input=await openSdx(memoryInput(bytes,requests),{maxReadBytes:budget}),offset=BigInt(4+text.length+28+name);
    expect(input.info).toMatchObject({container:'sdx',codec,channels:1,sampleRate:44100,channelMask:null,blockAlign:depth/8,bitsPerSample:depth,dataOffset:offset,dataBytes:BigInt(7*depth/8),durationSamples:7n,bitDepth:depth,nameBytes:name});
    expect(input.info.copyRefusal).toMatch(/1\/90000/);expect(requests.every(request=>request.length<=Math.min(budget,64))).toBe(true);
    // Byte by byte, only the scan up to 0x1a, the version and length bytes, and the depth and rate bytes are read: never the name, skipped bytes or payload.
    // Wider budgets scan in windows of at most 64 bytes that may overlap the rest of the header, and read nothing after the scan except those 2 and 5 bytes.
    const read=new Set(requests.flatMap(request=>Array.from({length:request.length},(_,i)=>Number(request.offset)+i))),marker=4+text.length,reach=budget===1?marker+1:marker+64;
    for(let i=0;i<4;i++)expect(read.has(i)).toBe(false);
    for(let i=Math.max(marker+3,reach);i<marker+3+name+4;i++)expect(read.has(i)).toBe(false);
    for(let i=Math.max(marker+3+name+9,reach);i<bytes.length;i++)expect(read.has(i)).toBe(false);
    requests.length=0;const packets=await collect(input,2n,budget);
    expect(packets.reduce((sum,packet)=>sum+(packet.duration??0n),0n)).toBe(5n);expect(Buffer.concat(packets.map(packet=>packet.data)).equals(Buffer.from(bytes.subarray(Number(offset)+2*depth/8)))).toBe(true);
    expect(packets[0]!).toMatchObject({pts:2n,timeBase:{num:1n,den:44100n}});expect(requests.every(request=>request.offset>=offset)).toBe(true);
  }
  // openRawPcm needs a read budget of one sample frame.
  await expect(openSdx(memoryInput(sdxFile({depth:16})),{maxReadBytes:1})).rejects.toThrow('read budget');
  // The first 0x1a after the magic wins, even inside the free text; a 0x1a among the four magic bytes is skipped.
  const early=sdxFile({text:'ab\x1a'});expect(await scanSdxMarker(memoryInput(early),64)).toBe(6n);
  const magic=sdxFile();magic[2]=0x1a;expect(await scanSdxMarker(memoryInput(magic),1)).toBe(4n);
  expect(await scanSdxMarker(memoryInput(Uint8Array.from([0x53,0x44,0x58,0x3a,1,2,3])),2)).toBeNull();
  // A zero-sample file opens with no packets.
  const empty=await openSdx(memoryInput(sdxFile({samples:0})),{maxReadBytes:64});expect(empty.info.durationSamples).toBe(0n);expect(await collect(empty)).toEqual([]);
  for(const rate of [1,8000,2147483647])expect((await openSdx(memoryInput(sdxFile({rate})),{maxReadBytes:64})).info.sampleRate).toBe(rate);
});
it('fails like read_header with INVALIDDATA and refuses the unmirrored forms',async()=>{
  const open=(bytes:Uint8Array,maxReadBytes=64)=>openSdx(memoryInput(bytes),{maxReadBytes});
  const noMarker=Uint8Array.from([...'SDX:no marker here at all'].map(c=>c.charCodeAt(0)));
  await expect(open(noMarker,3)).rejects.toEqual(refusal(183,'Invalid data found when processing input: SDX header marker'));
  await expect(open(Uint8Array.from([0x53,0x44,0x58]))).rejects.toEqual(refusal(183,'Invalid data found when processing input: SDX header marker'));
  await expect(open(Uint8Array.from([0x53,0x44,0x58,0x3a,0x1a]))).rejects.toEqual(refusal(183,'Invalid data found when processing input: SDX header version'));
  for(const version of [0,2,0x1a,255])await expect(open(sdxFile({version}))).rejects.toEqual(refusal(183,'Invalid data found when processing input: SDX header version'));
  for(const depth of [0,4,12,20,64,255])await expect(open(sdxFile({depth}))).rejects.toEqual(refusal(183,`Invalid data found when processing input: SDX bit depth ${depth}`));
  // Truncation before the depth byte reads 0 there (INVALIDDATA); after it, native would read a partial rate.
  const full=sdxFile({name:5,samples:0}),depthAt=4+3+5+4;
  for(const cut of [5,6,8,depthAt])await expect(open(full.subarray(0,cut))).rejects.toMatchObject({exitCode:183});
  for(const cut of [depthAt+1,depthAt+4,depthAt+5,full.length-1])await expect(open(full.subarray(0,cut))).rejects.toThrow('Truncated SDX header is not implemented');
  await expect(open(full)).resolves.toBeDefined();
  for(const rate of [0,2147483648,4294967295])await expect(open(sdxFile({rate}))).rejects.toEqual(refusal(234,`SDX sample rate ${rate} is not implemented`));
  for(const [depth,extra] of [[16,1],[24,1],[24,2],[32,3]] as const)await expect(open(sdxFile({depth,extra}))).rejects.toThrow('Partial trailing SDX sample is not implemented');
  await expect(open(sdxFile(),0)).rejects.toThrow('budget');await expect(open(sdxFile(),1.5)).rejects.toThrow('budget');
  const short:ReadHandle={size:100n,async readAt(){return new Uint8Array(0);}};await expect(openSdx(short,{maxReadBytes:64})).rejects.toThrow('read length');
  const long:ReadHandle={size:100n,async readAt(_offset,length){return new Uint8Array(length+1);}};await expect(openSdx(long,{maxReadBytes:64})).rejects.toThrow('read length');
});
it('checks the abort signal around every read',async()=>{
  const bytes=sdxFile({text:'x'.repeat(40),samples:50}),controller=new AbortController();controller.abort(new Error('stopped'));
  await expect(openSdx(memoryInput(bytes),{maxReadBytes:64,signal:controller.signal})).rejects.toThrow('stopped');
  for(const at of [1,3,5]){
    const live=new AbortController();let reads=0;
    const input:ReadHandle={size:BigInt(bytes.length),async readAt(offset,length,signal){if(++reads===at)live.abort(new Error(`read ${at}`));signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};
    await expect(openSdx(input,{maxReadBytes:8,signal:live.signal})).rejects.toThrow(`read ${at}`);
  }
  const later=new AbortController(),opened=await openSdx(memoryInput(bytes),{maxReadBytes:16,signal:later.signal}),iterator=opened.packets()[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);later.abort(new Error('packets'));await expect(iterator.next()).rejects.toThrow('packets');
});
it('probes the exact SDX: head and registers a demux-only descriptor',async()=>{
  const bytes=sdxFile(),requests:Array<{offset:bigint;length:number}>=[];
  expect(await detectAudioContainer(memoryInput(bytes,requests),2)).toBe('sdx');expect(requests.every(request=>request.length<=2&&request.offset+BigInt(request.length)<=4n)).toBe(true);
  for(const head of ['SDX;','sdx:','SDX ','XSDX','SDS:']){const changed=bytes.slice();changed.set([...head].map(c=>c.charCodeAt(0)));expect(sdx.demux.probe.head(changed)).toBe(false);await expect(detectAudioContainer(memoryInput(changed),64)).rejects.toThrow('signature');}
  expect(containerFormat('sdx')).toBe(sdx);expect(containerProbes).toContain(sdx);
  expect(sdx).toMatchObject({name:'sdx',demux:{probe:{precedence:100},headerBytes:128}});expect('mux' in sdx).toBe(false);expect('extensions' in sdx.demux).toBe(false);expect('packetSpan' in sdx.demux).toBe(false);expect('confirm' in sdx.demux.probe).toBe(false);
  expect(Object.isFrozen(sdx.demux)&&Object.isFrozen(sdx.demux.probe)).toBe(true);
  await expect(sdx.demux.open(memoryInput(bytes),{maxReadBytes:64,signal:new AbortController().signal,declared:{sampleRate:44100,channels:1,guessLayout:true},seek:1n})).rejects.toEqual(refusal(1,'SDX input seeking is not implemented'));
});
it('decodes through the PCM backend and refuses copy, input seeks, sdx output and bad inputs before any output opens',async()=>{
  const files=new Map<string,Uint8Array>();let opens=0;
  const filesystem={
    async openRead(path:string):Promise<ReadHandle>{const bytes=files.get(path);if(!bytes)throw new Error(`missing ${path}`);return memoryInput(bytes);},
    async openWrite(path:string):Promise<WriteHandle>{opens++;const chunks:Uint8Array[]=[];return {async write(chunk){chunks.push(chunk.slice());},async commit(){files.set(path,Uint8Array.from(chunks.flatMap(chunk=>[...chunk])));},async abort(){}};},
    async exists(path:string){return files.has(path);},async stat(path:string){const bytes=files.get(path);return bytes?{size:BigInt(bytes.length)}:null;}
  };
  const ffmpeg=new FFmpeg({filesystem:filesystem as never,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:256,maxPendingPackets:2,maxCpuTimeMs:1000}});
  const input=sdxFile({depth:8,rate:8000,samples:1000});files.set('/in.sdx',input);
  const raw=await ffmpeg.exec(['-i','/in.sdx','-f','u8','/out.raw']);expect(raw.exitCode,JSON.stringify(raw.diagnostics)).toBe(0);
  expect(Buffer.from(files.get('/out.raw')!).equals(Buffer.from(input.subarray(input.length-1000)))).toBe(true);
  const crc=await ffmpeg.exec(['-i','/in.sdx','-f','framecrc','/out.crc']);expect(crc.exitCode,JSON.stringify(crc.diagnostics)).toBe(0);
  // pcmPacketSpan(8000) is 512 samples: 512 then 488.
  expect(new TextDecoder().decode(files.get('/out.crc')).split('\n').filter(line=>/^0,/.test(line)).map(line=>line.split(',').slice(1,4).map(field=>Number(field)))).toEqual([[0,0,512],[512,512,488]]);
  opens=0;
  for(const args of [['-i','/in.sdx','-c:a','copy','-f','u8','/copy.raw'],['-i','/in.sdx','-c','copy','-f','framecrc','/copy.crc']]){const copy=await ffmpeg.exec(args);expect([copy.exitCode,copy.diagnostics.at(-1)?.code,copy.diagnostics.at(-1)?.message]).toEqual([1,'unsupported-command','SDX stream copy is not implemented: native packets use a 1/90000 time base']);}
  for(const [name,bytes,message] of [['/depth.sdx',sdxFile({depth:12}),'Invalid data found when processing input: SDX bit depth 12'],['/marker.sdx',Uint8Array.from([0x53,0x44,0x58,0x3a,1,2,3]),'Invalid data found when processing input: SDX header marker'],['/rate.sdx',sdxFile({rate:0}),'SDX sample rate 0 is not implemented'],['/tail.sdx',sdxFile({extra:1}),'Partial trailing SDX sample is not implemented']] as const){
    files.set(name,bytes);const result=await ffmpeg.exec(['-i',name,'-f','s16le','/bad.raw']);expect(result.exitCode).not.toBe(0);expect(result.diagnostics.at(-1)?.message).toBe(message);
  }
  const seek=await ffmpeg.exec(['-ss','0.001','-i','/in.sdx','-f','s16le','/seek.raw']);expect([seek.diagnostics.at(-1)?.code,seek.diagnostics.at(-1)?.message]).toEqual(['unsupported-command','SDX input seeking is not implemented']);
  const muxed=await ffmpeg.exec(['-i','/in.sdx','-f','sdx','/out.sdx']);expect(muxed.exitCode).not.toBe(0);expect(muxed.diagnostics.at(-1)?.message).toMatch(/Output requires/);
  expect(opens).toBe(0);
});
