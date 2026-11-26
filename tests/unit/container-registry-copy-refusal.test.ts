import {describe,expect,it,vi} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ReadHandle,VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {containerFormat} from '@edge-ffmpeg/containers';
import {collectingOutput} from '../helpers/output.js';

// A scratch demuxer added exactly as a new format is, whose info refuses stream copy (as a short-tail msf input does).
vi.mock('../../packages/containers/src/registry.js',async importOriginal=>{
 const {defineContainer}=await import('../../packages/containers/src/registry-descriptor.js');
 const {openRawPcm}=await import('../../packages/containers/src/raw-pcm.js');
 const after=(input:ReadHandle,offset:bigint):ReadHandle=>({size:input.size-offset,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)});
 return {...await importOriginal<Record<string,unknown>>(),
  // 'ECPY' then stereo s16le 8000 Hz to EOF; an odd sample count marks a short native tail that copy would flag.
  edgecopy:defineContainer({name:'edgecopy',demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='ECPY'},headerBytes:4,
   async open(source,{maxReadBytes,signal}){const raw=await openRawPcm(after(source,4n),{codec:'pcm_s16le',channels:2,sampleRate:8000,channelMask:null,maxReadBytes,signal});return {info:raw.info.durationSamples%2n?{...raw.info,copyRefusal:'EdgeCopy stream copy of a short final packet is not implemented'}:raw.info,packets:raw.packets};}}})
 };
});

// Stereo s16le, 8000 Hz, 21 and 20 sample frames.
const odd=new Uint8Array(84);for(let index=0;index<42;index++)new DataView(odd.buffer).setInt16(index*2,index*257-3000,true);
const even=odd.subarray(0,80);
const tagged=(payload:Uint8Array)=>Uint8Array.from([0x45,0x43,0x50,0x59,...payload]);
const memory=(bytes:Uint8Array):ReadHandle=>({size:BigInt(bytes.length),async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+length);}});
async function run(input:Uint8Array,args:readonly string[]){
 const sink=collectingOutput();let opens=0;
 const filesystem:VirtualFileSystem={async openRead(){return memory(input);},async openWrite(){opens++;return sink.output;}};
 const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args);
 return {result,opens,bytes:sink.bytes(),last:result.diagnostics.at(-1)};
}

describe('info.copyRefusal of a registered demuxer',()=>{
 it('refuses -c copy before output creation, after the codec check, and leaves decoding unchanged',async()=>{
  expect(containerFormat('edgecopy')?.demux).toBeDefined();
  const message='EdgeCopy stream copy of a short final packet is not implemented';
  for(const output of [['-f','framecrc','/out.crc'],['-f','s16le','/out.raw'],['/out.wav']]){
   const refused=await run(tagged(odd),['-i','/in.bin','-c:a','copy',...output]);expect([refused.result.exitCode,refused.last?.code,refused.last?.message,refused.opens],output.join(' ')).toEqual([1,'unsupported-command',message,0]);
  }
  // The codec check of step 6 runs first: copy of s16le into an s16be raw output keeps its own refusal.
  const codec=await run(tagged(odd),['-i','/in.bin','-c:a','copy','-f','s16be','/out.raw']);expect([codec.last?.message,codec.opens]).toEqual(['Raw PCM mux format must match the selected codec',0]);
  const decoded=await run(tagged(odd),['-i','/in.bin','-f','s16le','/out.raw']);expect(decoded.result.exitCode,JSON.stringify(decoded.result.diagnostics)).toBe(0);expect(decoded.bytes).toEqual(odd);
  const encoded=await run(tagged(odd),['-i','/in.bin','-c:a','pcm_s16le','-f','framecrc','/out.crc']);expect(encoded.result.exitCode).toBe(0);expect(new TextDecoder().decode(encoded.bytes)).toContain('#sample_rate 0: 8000');
  // An input without copyRefusal copies as before.
  const copied=await run(tagged(even),['-i','/in.bin','-c:a','copy','-f','s16le','/out.raw']);expect(copied.result.exitCode,JSON.stringify(copied.result.diagnostics)).toBe(0);expect(copied.bytes).toEqual(even);
 });
});
