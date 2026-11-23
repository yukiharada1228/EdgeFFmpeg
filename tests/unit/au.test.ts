import {expect,it} from 'vitest';
import {openAu,muxAu,validateAuOutput,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
function fixture(offset=32,size=3){const bytes=new Uint8Array(offset+3),view=new DataView(bytes.buffer);[0x2e736e64,offset,size,2,8000,1].forEach((value,i)=>view.setUint32(i*4,value,false));bytes.set([128,0,127],offset);return bytes;}
async function collect(input:Awaited<ReturnType<typeof openAu>>,start=0n){const result=[];for await(const packet of input.packets(start))result.push(packet);return result;}
it('skips AU annotations bounds short reads supports unknown-size finite input and seeks',async()=>{
  for(const size of [3,0xffffffff]){
    const requests:Array<{offset:bigint;length:number}>=[],bytes=fixture(4096,size),input=await openAu(memoryInput(bytes,requests),{maxReadBytes:1});expect(input.info).toMatchObject({codec:'pcm_s8',durationSamples:3n,dataOffset:4096n,declaredDataBytes:size===3?3n:null});expect(await detectAudioContainer(memoryInput(bytes),1)).toBe('au');
    const packets=await collect(input,1n);expect(packets.map(packet=>[packet.pts,[...packet.data]])).toEqual([[1n,[0]],[2n,[127]]]);expect(requests.every(request=>request.length===1&&(request.offset<24n||request.offset>=4096n))).toBe(true);await expect(collect(input,4n)).rejects.toThrow('seek');
  }
});
it('rejects malformed AU offsets sizes encodings rates alignment and unsafe output lengths',async()=>{
  const mutations=[[8,0],[8,1],[0,0],[4,23],[4,100],[8,4],[12,99],[16,0],[16,0xffffffff],[20,0],[20,65536],[12,3]];
  for(const [offset,value]of mutations){const data=fixture();new DataView(data.buffer).setUint32(offset!,value!,false);await expect(openAu(memoryInput(data),{maxReadBytes:8})).rejects.toThrow();}
  await expect(openAu(memoryInput(fixture().subarray(0,23)),{maxReadBytes:8})).rejects.toThrow('Truncated');
  expect(()=>validateAuOutput({codec:'pcm_s16be',sampleRate:8000,channels:1},0xffffffffn)).toThrow('32-bit');
});
it('aborts AU output exactly once on failed packets and honors cancellation before reads',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));await expect(openAu(memoryInput(fixture()),{maxReadBytes:8,signal:controller.signal})).rejects.toThrow('stop');
  const sink=collectingOutput();let aborted=0;async function* packets():AsyncIterable<MediaPacket>{yield {streamIndex:0,data:new Uint8Array([128,0,127]),pts:0n,dts:0n,duration:3n,timeBase:{num:1n,den:8000n},flags:1};}
  await expect(muxAu({...sink.output,async abort(reason){aborted++;await sink.output.abort(reason);}},{codec:'pcm_s8',channels:1,sampleRate:8000},packets(),{sampleCount:4n,maxWriteBytes:7})).rejects.toThrow('duration');expect(aborted).toBe(1);expect(sink.aborted).toBe(true);expect(sink.committed).toBe(false);expect(sink.lengths).toEqual([]);
});
