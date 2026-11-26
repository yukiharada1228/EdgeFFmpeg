import {describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {containerFormat,containerOutputListing} from '@edge-ffmpeg/containers';
import type {ContainerOutputStream} from '@edge-ffmpeg/containers';
import {framehash,framemd5,muxFrameHash,validateFrameHashOutput} from '../../packages/containers/src/hash/frame-hash-mux.js';
import {collectingOutput} from '../helpers/output.js';
const format={codec:'pcm_s16le',sampleRate:10,channelLayout:'mono'} as const;
const packet=(data:Uint8Array,pts:bigint,overrides:Partial<MediaPacket>={}):MediaPacket=>({streamIndex:0,data,pts,dts:pts,duration:BigInt(data.length>>1),timeBase:{num:1n,den:10n},flags:1,...overrides});
async function* source(...packets:MediaPacket[]){yield* packets;}
const bytes=(length:number,seed=1)=>Uint8Array.from({length},(_,i)=>(i*37+seed*11)&255);
const hex=(algorithm:string,data:Uint8Array)=>createHash(algorithm).update(data).digest('hex');
const text=(sink:ReturnType<typeof collectingOutput>)=>new TextDecoder().decode(sink.bytes());
const rows=(value:string)=>value.split('\n').filter(line=>line.startsWith('0,'));
const header='#tb 0: 1/10\n#media_type 0: audio\n#codec_id 0: pcm_s16le\n#sample_rate 0: 10\n#channel_layout_name 0: mono\n#stream#, dts,        pts, duration,     size, hash\n';
const stream=(overrides:Partial<ContainerOutputStream>={}):ContainerOutputStream=>({codec:'pcm_s16le',channels:1,sampleRate:8000,channelMask:null,layoutMask:null,channelLayout:'mono',samples:0n,bitexact:false,options:[],...overrides});
describe('framemd5 and framehash muxers',()=>{
  it('registers output-only descriptors with the pcm_s16le default, any PCM codec and no input metadata',()=>{
    for(const [descriptor,name] of [[framemd5,'framemd5'],[framehash,'framehash']] as const){
      expect(containerFormat(name)).toBe(descriptor);expect(descriptor.mux).toMatchObject({label:name,defaultCodec:'pcm_s16le',dropsMetadata:true});expect('demux' in descriptor).toBe(false);
      expect(descriptor.mux.options).toBeUndefined();expect(descriptor.mux.extensions).toBeUndefined();for(const codec of ['pcm_u8','pcm_f64be','pcm_alaw','pcm_mulaw'] as const)expect(descriptor.mux.supports(codec)).toBe(true);
      expect(containerOutputListing.split(', ')).toContain(name);
    }
  });
  it('writes the frame checksums header with the reference software line unless bitexact',async()=>{
    for(const [name,hashName] of [['framemd5','MD5'],['framehash','SHA256']] as const){
      const plain=collectingOutput();await muxFrameHash(plain.output,name,format,source(),{maxWriteBytes:1024,metadataProfile:'ffmpeg-9.0.2',framing:{blockAlign:2,samplesPerPacket:4n,sampleCount:0n}});
      expect(text(plain)).toBe(`#format: frame checksums\n#version: 2\n#hash: ${hashName}\n#software: Lavf63.1.102\n${header}`);expect(plain.committed).toBe(true);
      const own=collectingOutput();await muxFrameHash(own.output,name,format,source(),{maxWriteBytes:1024,framing:{blockAlign:2,samplesPerPacket:4n,sampleCount:0n}});expect(text(own)).toContain('#software: EdgeFFmpeg\n');
      const exact=collectingOutput();await muxFrameHash(exact.output,name,format,source(),{maxWriteBytes:1024,bitexact:true,metadataProfile:'ffmpeg-9.0.2',framing:{blockAlign:2,samplesPerPacket:4n,sampleCount:0n}});
      expect(text(exact)).toBe(`#format: frame checksums\n#version: 2\n#hash: ${hashName}\n${header}`);
    }
  });
  it('formats rows without a flags column and hashes regrouped packets independently of chunk boundaries and write budget',async()=>{
    const data=bytes(14);
    for(const [name,algorithm] of [['framemd5','md5'],['framehash','sha256']] as const)for(const split of [[14],[2,12],[2,2,2,2,2,2,2],[6,8]])for(const budget of [1,7,4096]){
      let offset=0;const chunks=split.map(length=>{const chunk=packet(data.subarray(offset,offset+length),BigInt(offset/2));offset+=length;return chunk;});
      const sink=collectingOutput();await muxFrameHash(sink.output,name,format,source(...chunks),{maxWriteBytes:budget,bitexact:true,framing:{blockAlign:2,samplesPerPacket:3n,firstPacketSamples:2n,sampleCount:7n,startPts:5n}});
      expect(rows(text(sink))).toEqual([
        `0,          5,          5,        2,        4, ${hex(algorithm,data.subarray(0,4))}`,
        `0,          7,          7,        3,        6, ${hex(algorithm,data.subarray(4,10))}`,
        `0,         10,         10,        2,        4, ${hex(algorithm,data.subarray(10,14))}`]);
      expect(sink.lengths.every(length=>length<=budget)).toBe(true);expect(sink.committed).toBe(true);
    }
  });
  it('regroups with packet sections and cumulative packet schedules',async()=>{
    const data=bytes(14,3),sections=collectingOutput();
    await muxFrameHash(sections.output,'framemd5',format,source(packet(data,0n)),{maxWriteBytes:8,bitexact:true,framing:{blockAlign:2,samplesPerPacket:4n,sampleCount:7n,sections:[{samples:5n,span:4n},{samples:2n,span:2n}]}});
    expect(rows(text(sections)).map(line=>line.split(', ').map(value=>value.trim()))).toEqual([['0','0','0','4','8',hex('md5',data.subarray(0,8))],['0','4','4','1','2',hex('md5',data.subarray(8,10))],['0','5','5','2','4',hex('md5',data.subarray(10,14))]]);
    const packetSchedule={sampleCount:7n,packetCount:3n,samplesForPackets:(n:bigint)=>n===0n?0n:n===1n?2n:n===2n?6n:7n},scheduled=collectingOutput();
    await muxFrameHash(scheduled.output,'framehash',format,source(packet(data,0n)),{maxWriteBytes:8,bitexact:true,framing:{blockAlign:2,samplesPerPacket:1n,sampleCount:7n,packetSchedule}});
    expect(rows(text(scheduled)).map(line=>line.split(', ').slice(4).map(value=>value.trim()))).toEqual([['4',hex('sha256',data.subarray(0,4))],['8',hex('sha256',data.subarray(4,12))],['2',hex('sha256',data.subarray(12,14))]]);
  });
  it('refuses options, empty layouts and invalid parameters, framing and packets, and aborts without committing',async()=>{
    for(const name of ['framemd5','framehash'] as const){
      for(const option of ['-hash','-format_version'])expect(()=>validateFrameHashOutput(name,'mono',[{name:option,value:'1'}])).toThrow(`The ${name} muxer ${option} option is not implemented`);
      expect(()=>containerFormat(name)!.mux!.validate!(stream({channelLayout:''}))).toThrow(`Unknown channel mask for ${name} output`);expect(()=>containerFormat(name)!.mux!.validate!(stream())).not.toThrow();
    }
    const framing={blockAlign:2,samplesPerPacket:3n,sampleCount:2n};
    const cases:[Parameters<typeof muxFrameHash>[2],AsyncIterable<MediaPacket>,Parameters<typeof muxFrameHash>[4],string|RegExp][]=[
      [{...format,channelLayout:'mono\ninjected'},source(),{maxWriteBytes:8,framing},'parameters'],
      [{...format,sampleRate:0},source(),{maxWriteBytes:8,framing},'parameters'],
      [format,source(),{maxWriteBytes:0,framing},'parameters'],
      [format,source(),{maxWriteBytes:8,framing:{...framing,samplesPerPacket:0n}},'Invalid framemd5 framing'],
      [format,source(),{maxWriteBytes:8,framing:{...framing,sections:[{samples:3n,span:2n}]}},'Invalid framemd5 packet sections'],
      [format,source(packet(bytes(4),0n,{timeBase:{num:1n,den:20n}})),{maxWriteBytes:8,framing},'Invalid framemd5 packet'],
      [format,source(packet(bytes(4),0n,{streamIndex:1})),{maxWriteBytes:8,framing},'Invalid framemd5 packet'],
      [format,source(packet(bytes(4),1n)),{maxWriteBytes:8,framing},'Invalid contiguous PCM framemd5 chunks'],
      [format,source(packet(bytes(3),0n,{duration:1n})),{maxWriteBytes:8,framing},'Unaligned PCM framemd5 chunk'],
      [format,source(packet(bytes(2),0n)),{maxWriteBytes:8,framing},'Framemd5 sample count mismatch'],
    ];
    for(const [value,packets,options,message] of cases){
      const sink=collectingOutput();await expect(muxFrameHash(sink.output,'framemd5',value,packets,options)).rejects.toThrow(message);expect(sink.aborted).toBe(true);expect(sink.committed).toBe(false);
    }
    const overflow=collectingOutput();await expect(muxFrameHash(overflow.output,'framemd5',format,source(packet(bytes(2),0n)),{maxWriteBytes:8,framing:{blockAlign:2,samplesPerPacket:1n,sampleCount:1n,startPts:1n<<63n}})).rejects.toThrow('Timestamp exceeds');expect(overflow.aborted).toBe(true);
  });
  it('honors cancellation, failed writes and failed aborts',async()=>{
    const framing={blockAlign:2,samplesPerPacket:2n,sampleCount:4n};
    const controller=new AbortController();controller.abort('cancel');const cancelled=collectingOutput();
    await expect(muxFrameHash(cancelled.output,'framehash',format,source(packet(bytes(8),0n)),{maxWriteBytes:8,framing,signal:controller.signal})).rejects.toBe('cancel');expect(cancelled.aborted).toBe(true);
    const later=new AbortController(),midway=collectingOutput();
    async function* stop(){yield packet(bytes(4),0n);later.abort('later');yield packet(bytes(4),2n);}
    await expect(muxFrameHash(midway.output,'framehash',format,stop(),{maxWriteBytes:8,framing,signal:later.signal})).rejects.toBe('later');expect(midway.aborted).toBe(true);expect(midway.committed).toBe(false);
    const failed=collectingOutput();await expect(muxFrameHash({...failed.output,async write(){throw new Error('write failed');}},'framemd5',format,source(),{maxWriteBytes:8,framing})).rejects.toThrow('write failed');expect(failed.aborted).toBe(true);
    const broken=collectingOutput();await expect(muxFrameHash({...broken.output,async write(){throw new Error('write failed');},async abort(){throw new Error('abort failed');}},'framemd5',format,source(),{maxWriteBytes:8,framing})).rejects.toThrow('Frame hash muxer output and abort failed');
  });
});
