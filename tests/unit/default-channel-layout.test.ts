import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';
import {defaultChannelLayout} from '@edge-ffmpeg/avutil';import {muxWav} from '@edge-ffmpeg/containers';import {collectingOutput} from '../helpers/output.js';import type {MediaPacket} from '@edge-ffmpeg/core';
async function* empty():AsyncIterable<MediaPacket>{}
it('matches every defined Native default layout across all WAV channel counts without truncating wide masks',()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/default-channel-layout/native-layouts.json','utf8')) as {layouts:{channels:number;name:string;mask:string}[]};expect(fixture.layouts).toHaveLength(13);
 const expected=new Map(fixture.layouts.map(row=>[row.channels,{...row,mask:BigInt(row.mask)}]));for(let channels=1;channels<=65535;channels++){const actual=defaultChannelLayout(channels);expect(actual).toEqual(expected.get(channels)??null);if(actual)expect(Object.isFrozen(actual)).toBe(true);}
 for(const invalid of [0,-1,NaN,Infinity,1.5])expect(defaultChannelLayout(invalid)).toBeNull();
});
it('accepts exact uint64 WAV masks only in the Native profile and rejects invalid or legacy-wide masks before writes',async()=>{
 for(const mask of [0,3,4,0x3ffff,0xffffffff])for(const metadataProfile of [undefined,'ffmpeg-9.0.2'] as const){
  const numeric=collectingOutput(),integer=collectingOutput(),options={sampleCount:0n,maxWriteBytes:7,bitexact:true,...(metadataProfile===undefined?{}:{metadataProfile})};
  for(const [sink,channelMask]of [[numeric,mask],[integer,BigInt(mask)]] as const)await muxWav(sink.output,{codec:'pcm_s16le',channels:1,sampleRate:8000,channelMask},empty(),options);
  expect(integer.bytes()).toEqual(numeric.bytes());expect(integer.committed&&numeric.committed).toBe(true);expect(integer.aborted||numeric.aborted).toBe(false);
 }
 const maximum=collectingOutput();await muxWav(maximum.output,{codec:'pcm_s16le',channels:64,sampleRate:8000,channelMask:(1n<<64n)-1n},empty(),{sampleCount:0n,maxWriteBytes:7,bitexact:true,metadataProfile:'ffmpeg-9.0.2'});expect(maximum.committed).toBe(true);expect(new DataView(maximum.bytes().buffer).getUint32(40,true)).toBe(0);
 for(const mask of [-1n,1n<<64n,NaN,Infinity,1.5,0x100000000]){const sink=collectingOutput();await expect(muxWav(sink.output,{codec:'pcm_s16le',channels:1,sampleRate:8000,channelMask:mask},empty(),{sampleCount:0n,maxWriteBytes:7,metadataProfile:'ffmpeg-9.0.2'})).rejects.toThrow('Invalid WAV channel mask');expect(sink.aborted).toBe(true);expect(sink.lengths).toEqual([]);}
 for(const channels of [16,24]){const layout=defaultChannelLayout(channels)!;const sink=collectingOutput();await muxWav(sink.output,{codec:'pcm_s16le',channels,sampleRate:8000,channelMask:layout.mask},empty(),{sampleCount:0n,maxWriteBytes:7,metadataProfile:'ffmpeg-9.0.2',bitexact:true});const bytes=sink.bytes(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);expect(view.getUint16(20,true)).toBe(65534);expect(view.getUint32(40,true)).toBe(0);expect(layout.mask).toBe(channels===16?206158616319n:2164663779327n);expect(sink.committed).toBe(true);
 const legacy=collectingOutput();await expect(muxWav(legacy.output,{codec:'pcm_s16le',channels,sampleRate:8000,channelMask:layout.mask},empty(),{sampleCount:0n,maxWriteBytes:7})).rejects.toThrow('Invalid WAV channel mask');expect(legacy.aborted).toBe(true);expect(legacy.lengths).toEqual([]);}
});
