import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat,detectAudioContainer,inputContainerFor,outputContainerFor} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {openSln,sln} from '../../packages/containers/src/sln.js';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
function samples(count:number):Uint8Array{const bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,(i*2741+17)%65536-32768,true);return bytes;}
async function collect(input:Awaited<ReturnType<typeof openSln>>,start=0n,max?:number){const result:MediaPacket[]=[];for await(const packet of input.packets(start,max))result.push(packet);return result;}
async function run(input:Uint8Array,args:readonly string[]){
  const sink=collectingOutput();let opens=0;
  const filesystem:VirtualFileSystem={async openRead(){return memoryInput(input);},async openWrite(){opens++;return sink.output;}};
  const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args);
  return {result,opens,bytes:sink.bytes(),last:result.diagnostics.at(-1)};
}
it('opens the whole input as pcm_s16le 8000 Hz mono with no header read and bounded packet reads',async()=>{
  for(const count of [0,1,511,512,513,3000]){
    const bytes=samples(count),requests:Array<{offset:bigint;length:number}>=[],input=await openSln(memoryInput(bytes,requests),{maxReadBytes:6});
    expect(input.info).toMatchObject({container:'sln',codec:'pcm_s16le',channels:1,sampleRate:8000,channelMask:null,blockAlign:2,bitsPerSample:16,dataOffset:0n,dataBytes:BigInt(count*2),durationSamples:BigInt(count)});
    expect(requests).toEqual([]);expect(Object.isFrozen(input.info)).toBe(true);
    const all=await collect(input);expect(requests.every(request=>request.length<=6)).toBe(true);
    expect(all.reduce((sum,packet)=>sum+packet.data.length,0)).toBe(count*2);expect(Buffer.concat(all.map(packet=>packet.data)).equals(Buffer.from(bytes))).toBe(true);
    expect(all.every((packet,i)=>packet.pts===BigInt(i*3)&&packet.timeBase.den===8000n)).toBe(true);
    if(count>=2){const tail=await collect(input,1n,2);expect(tail[0]!.pts).toBe(1n);expect([...tail[0]!.data]).toEqual([...bytes.subarray(2,4)]);}
  }
});
it('refuses partial trailing samples input seeks invalid budgets and aborted opens',async()=>{
  for(const size of [1,3,1025])await expect(openSln(memoryInput(new Uint8Array(size)),{maxReadBytes:64})).rejects.toMatchObject({code:'unsupported',message:'SLN partial trailing sample is not implemented'});
  for(const seek of [1n,1000000n])await expect(openSln(memoryInput(samples(4)),{maxReadBytes:64,seek})).rejects.toThrow('SLN input seek is not implemented');
  expect((await openSln(memoryInput(samples(4)),{maxReadBytes:64,seek:0n})).info.durationSamples).toBe(4n);
  for(const maxReadBytes of [0,1,1.5,Number.NaN])await expect(openSln(memoryInput(samples(4)),{maxReadBytes})).rejects.toThrow('Invalid SLN read budget');
  const controller=new AbortController();controller.abort(new Error('stop'));await expect(openSln(memoryInput(samples(4)),{maxReadBytes:8,signal:controller.signal})).rejects.toThrow('stop');
  const input=await openSln(memoryInput(samples(8)),{maxReadBytes:4,signal:controller.signal}).catch(()=>null);expect(input).toBeNull();
  const live=new AbortController(),opened=await openSln(memoryInput(samples(8)),{maxReadBytes:4,signal:live.signal}),iterator=opened.packets()[Symbol.asyncIterator]();
  expect((await iterator.next()).value.data.length).toBe(4);live.abort(new Error('halt'));await expect(iterator.next()).rejects.toThrow('halt');
});
it('registers SLN as a demux-only extension-only format with no header bytes and the default packet span',async()=>{
  expect(containerFormat('sln')).toBe(sln);expect(Object.isFrozen(sln)&&Object.isFrozen(sln.demux)&&Object.isFrozen(sln.demux.extensions)).toBe(true);
  expect(sln.demux).toMatchObject({extensions:['.sln'],headerBytes:0});expect(['probe','packetSpan','seekBeyondEnd'].some(key=>key in sln.demux)).toBe(false);
  expect('mux' in sln).toBe(false);expect('headerless' in sln).toBe(false);
  expect(inputContainerFor('/a/B.SLN')?.name).toBe('sln');expect(inputContainerFor('/a/b.sln.wav')?.name).not.toBe('sln');expect(outputContainerFor('/x.sln')).toBeUndefined();
  const bytes=samples(4),requests:Array<{offset:bigint;length:number}>=[];
  expect(await detectAudioContainer(memoryInput(bytes,requests),64,undefined,'/in.sln')).toBe('sln');expect(requests).toEqual([{offset:0n,length:4}]);
  await expect(detectAudioContainer(memoryInput(bytes),64,undefined,'/in.dat')).rejects.toThrow('Unsupported audio container signature');
  const opened=await sln.demux.open(memoryInput(bytes),{maxReadBytes:8,signal:new AbortController().signal,declared:{sampleRate:44100,channels:2,guessLayout:true},seek:0n});expect(opened.info).toMatchObject({sampleRate:8000,channels:1,codec:'pcm_s16le'});
  await expect(sln.demux.open(memoryInput(bytes),{maxReadBytes:8,signal:new AbortController().signal,declared:{sampleRate:44100,channels:1,guessLayout:true},seek:5n})).rejects.toThrow('seek');
});
it('copies SLN to raw s16le and refuses -ar -ac -sample_rate -ch_layout input -ss partial samples and SLN output before opening an output',async()=>{
  const bytes=samples(600);
  for(const args of [['-f','sln','-i','/in.dat','-f','s16le','/out.raw'],['-i','/in.sln','-f','s16le','/out.raw'],['-i','/in.sln','-c:a','copy','-f','s16le','/out.raw']]){
    const {result,opens,bytes:out}=await run(bytes,args);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(opens).toBe(1);expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
  }
  for(const [input,args,message] of [
    [bytes,['-f','sln','-ar','16000','-i','/in.sln','-f','s16le','/o.raw'],'Input rate/channel declarations currently require a raw PCM format'],
    [bytes,['-f','sln','-ac','2','-i','/in.sln','-f','s16le','/o.raw'],'Input rate/channel declarations currently require a raw PCM format'],
    [bytes,['-ar','8000','-i','/in.sln','-f','s16le','/o.raw'],'Input rate/channel declarations currently require a raw PCM format'],
    [bytes,['-f','sln','-sample_rate','16000','-i','/in.sln','-f','s16le','/o.raw'],'-sample_rate'],
    [bytes,['-f','sln','-ch_layout','stereo','-i','/in.sln','-f','s16le','/o.raw'],'-ch_layout'],
    [bytes,['-ss','0.01','-f','sln','-i','/in.sln','-f','s16le','/o.raw'],'SLN input seek is not implemented'],
    [new Uint8Array(1201),['-i','/in.sln','-f','s16le','/o.raw'],'SLN partial trailing sample is not implemented'],
    [bytes,['-i','/in.sln','-f','sln','/o.sln'],'Output requires'],
    [bytes,['-i','/in.sln','/o.sln'],'Output requires']
  ] as const){const {result,opens}=await run(input,args);expect(result.exitCode,args.join(' ')).not.toBe(0);expect(opens,args.join(' ')).toBe(0);expect(JSON.stringify(result.diagnostics),args.join(' ')).toContain(message);}
});
