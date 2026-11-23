import {expect,it} from 'vitest';
import {openAiff,muxAiff,detectAudioContainer} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {memoryInput} from '../helpers/wav.js';
import {collectingOutput} from '../helpers/output.js';
function fixture(){
  const data=new Uint8Array(58),view=new DataView(data.buffer),text=(value:string,offset:number)=>data.set([...value].map(value=>value.charCodeAt(0)),offset);
  text('FORM',0);view.setUint32(4,50,false);text('AIFF',8);text('COMM',12);view.setUint32(16,18,false);view.setUint16(20,1,false);view.setUint32(22,3,false);view.setUint16(26,8,false);data.set([0x40,0x0b,0xfa,0,0,0,0,0,0,0],28);
  text('SSND',38);view.setUint32(42,11,false);data.set([128,0,127],54);return data;
}
async function collect(input:Awaited<ReturnType<typeof openAiff>>,start=0n){const output=[];for await(const packet of input.packets(start))output.push(packet);return output;}
it('reads bounded AIFF chunks and exact sample seeks including nonzero SSND offsets',async()=>{
  const data=new Uint8Array(60);data.set(fixture().subarray(0,54));const view=new DataView(data.buffer);view.setUint32(4,52,false);view.setUint32(42,14,false);view.setUint32(46,3,false);data.set([9,8,7,128,0,127],54);
  const requests:Array<{offset:bigint;length:number}>=[],input=await openAiff(memoryInput(data,requests),{maxReadBytes:1});expect(input.info).toMatchObject({codec:'pcm_s8',sampleRate:8000,durationSamples:3n,dataOffset:57n,defaultPacketSamples:4096n});
  const packets=await collect(input,1n);expect(packets.map(packet=>[packet.pts,[...packet.data]])).toEqual([[1n,[0]],[2n,[127]]]);expect(requests.every(request=>request.length===1&&request.offset+1n<=60n)).toBe(true);
  await expect(collect(input,4n)).rejects.toThrow('seek');expect(await detectAudioContainer(memoryInput(data),1)).toBe('aiff');await expect(detectAudioContainer(memoryInput(new Uint8Array([1,2,3,4])),4)).rejects.toThrow('signature');
});
it('rejects oversized chunks invalid common fields fractional rates blocked sound and count mismatches',async()=>{
  const invalid=[(data:Uint8Array)=>new DataView(data.buffer).setUint32(16,0xffffffff,false),(data:Uint8Array)=>new DataView(data.buffer).setUint32(22,0xffffffff,false),(data:Uint8Array)=>new DataView(data.buffer).setUint16(26,20,false),(data:Uint8Array)=>{data[37]=1;},(data:Uint8Array)=>new DataView(data.buffer).setUint32(50,1,false),(data:Uint8Array)=>new DataView(data.buffer).setUint32(46,4,false)];
  for(const mutate of invalid){const data=fixture();mutate(data);await expect(openAiff(memoryInput(data),{maxReadBytes:8})).rejects.toThrow();}
  await expect(openAiff(memoryInput(fixture().subarray(0,57)),{maxReadBytes:8})).rejects.toThrow('FORM size');await expect(openAiff(memoryInput(fixture()),{maxReadBytes:8,maxChunks:1})).rejects.toThrow('chunk count');
});
it('bounds reads for deterministic malformed header mutations without output-sized allocation',async()=>{
  const locations=[4,16,20,22,26,28,30,34,42,46,50];
  for(let i=0;i<256;i++){
    const data=fixture(),location=locations[i%locations.length]!,view=new DataView(data.buffer);view.setUint32(location,(Math.imul(i+1,2654435761))>>>0,false);
    const requests:Array<{offset:bigint;length:number}>=[];
    try{const input=await openAiff(memoryInput(data,requests),{maxReadBytes:8,maxChunks:4});await collect(input);}catch(error){expect(error).toBeDefined();}
    expect(requests.every(request=>request.length<=8&&request.offset>=0n&&request.offset+BigInt(request.length)<=BigInt(data.length))).toBe(true);
  }
});
it('checks cancellation and aborts exactly once on failed AIFF data production',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));await expect(openAiff(memoryInput(fixture()),{maxReadBytes:8,signal:controller.signal})).rejects.toThrow('stop');
  const sink=collectingOutput();let aborted=0;
  async function* packets():AsyncIterable<MediaPacket>{yield{streamIndex:0,data:new Uint8Array([128,0,127]),pts:0n,dts:0n,duration:3n,timeBase:{num:1n,den:8000n},flags:1};}
  await expect(muxAiff({...sink.output,async abort(reason){aborted++;await sink.output.abort(reason);}},{codec:'pcm_s8',channels:1,sampleRate:8000},packets(),{sampleCount:4n,maxWriteBytes:7})).rejects.toThrow('duration');expect(aborted).toBe(1);expect(sink.aborted).toBe(true);expect(sink.committed).toBe(false);
});
