/** Independent Native bytes exercise the real Wasm decoder -> remix -> PCM/mux pipeline. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import type {AudioFrameData,MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {encodePcm} from '@edge-ffmpeg/avcodec';
import {createFlacDecoder} from '../../packages/avcodec/src/flac/decoder.js';
import {ResourceContext} from '../../packages/core/src/resources.js';
import {remixFlacAudio} from '../../packages/avformat/src/flac-wave-remix.js';
import {muxFlacOutput} from '../../packages/avformat/src/flac-output.js';
import arithmeticProfile from '../../compat/behavior-specs/flac-max-remix/arithmetic.json' with {type:'json'};

interface Descriptor {streamId:number;codec:string;sampleRate:number;channels:1|2;channelLayout:'mono'|'stereo';bitsPerSample:number;totalSamples:number}
interface Packet {streamId:number;dts:number;pts:number;duration:number;bytes:number;checksum:string}
interface Row {
 id:string;input:string;inputSha256:string;output:string|null;outputSha256:string|null;exitCode:number;
 format:string;sampleWidth:number;sampleCount?:number;selectedStreamIds:number[];descriptors:Descriptor[];
 outputDescriptor:Omit<Descriptor,'bitsPerSample'|'totalSamples'>&{codec:PcmCodec};
 packets?:Packet[];framecrc?:string;rawPartner?:string;
}
interface Evidence {binarySha256:string;wasmSha256:string;rows:Row[];limits:{nativeCalls:number;sequential:boolean}}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
// Missing independent evidence is deliberately a hard dependency failure, never a skip or fabricated baseline.
const evidence=JSON.parse(readFileSync('compat/behavior-specs/flac-max-remix/cases.json','utf8')) as Evidence;
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const maxBytes=512*1024;
function fixture(value:string){expect(value.length).toBeLessThanOrEqual(Math.ceil(maxBytes/3)*4);const bytes=Buffer.from(value,'base64');expect(bytes.length).toBeLessThanOrEqual(maxBytes);return bytes;}
function targetFormat(codec:PcmCodec):AudioSampleFormat{
 switch(codec){case 'pcm_s16le':return 's16';case 'pcm_s32le':return 's32';case 'pcm_f32le':return 'flt';case 'pcm_f64le':return 'dbl';default:throw new Error('Unexpected Native remix codec '+codec);}
}
function parsePackets(text:string):Packet[]{
 return text.split('\n').filter(line=>/^\d+,/.test(line)).map(line=>{const f=line.split(',').map(value=>value.trim());return {streamId:Number(f[0]),dts:Number(f[1]),pts:Number(f[2]),duration:Number(f[3]),bytes:Number(f[4]),checksum:f[5]!};});
}

async function pipeline(row:Row){
 const input=fixture(row.input);expect(hash(input)).toBe(row.inputSha256);
 const abort=new AbortController(),signal=abort.signal;
 const resources=new ResourceContext({maxResidentBytes:32*1024*1024,maxBufferBytes:maxBytes,maxCpuTimeMs:10000,maxPendingPackets:1},signal);
 const releaseInput=resources.reserveExternalMemory(input.length);
 const source=row.descriptors[0]!,destination=row.outputDescriptor;
 let reads=0,decodedSamples=0n,outputSamples=0n,commits=0,aborts=0;
 const chunks:Buffer[]=[],frames:{pts:bigint;samples:number}[]=[];
 let retainedBytes=0;
 const retainedReleases:(()=>void)[]=[];
 const decoder=await createFlacDecoder(module,{size:BigInt(input.length),async readAt(offset,length){reads++;expect(length).toBeLessThanOrEqual(257);return input.subarray(Number(offset),Number(offset)+length);}},{signal,maxReadBytes:257,maxFrameBytes:maxBytes,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
 async function* decoded():AsyncGenerator<AudioFrameData>{
  try{for(;;){
   const item=await decoder.next();
   expect(item.metadata).toMatchObject({channels:source.channels,sampleRate:source.sampleRate,bitsPerSample:source.bitsPerSample,totalSamples:BigInt(source.totalSamples)});
   if(item.status==='end')return;if(item.status!=='frame')continue;
   try{
    expect(item.samplePosition).toBe(decodedSamples);
    // Reproduce the Native FLAC decoder's signed16/signed32 source negotiation, not the remix result.
    const width=source.bitsPerSample<=16?2:4,bytes=item.samples*source.channels*width,release=resources.reserveExternalMemory(bytes);
    try{
     expect(bytes).toBeLessThanOrEqual(maxBytes);const packed=new Uint8Array(bytes),view=new DataView(packed.buffer);
     for(let sample=0;sample<item.samples;sample++)for(let channel=0;channel<source.channels;channel++){
      const value=item.planes[channel]![sample]!<<(width*8-source.bitsPerSample),offset=(sample*source.channels+channel)*width;
      if(width===2)view.setInt16(offset,value,true);else view.setInt32(offset,value,true);
     }
     const pts=decodedSamples;decodedSamples+=BigInt(item.samples);
     yield {sampleRate:source.sampleRate,channels:source.channels,channelLayout:source.channelLayout,sampleFormat:width===2?'s16':'s32',samples:item.samples,planes:[packed],pts:{value:pts,timeBase:{num:1n,den:BigInt(source.sampleRate)}}};
    }finally{release();}
   }finally{item.release();}
  }}finally{await decoder.close();}
 }
 const arithmetic=arithmeticProfile.default.arithmetic;
 if(arithmetic!=='fused'&&arithmetic!=='separate')throw Error('Unknown pinned Native arithmetic profile');
 expect(arithmeticProfile.binarySha256).toBe(evidence.binarySha256);
 const remixed=remixFlacAudio(decoded(),destination.channels,targetFormat(destination.codec),{resources,signal,maxFrameBytes:maxBytes,arithmetic});
 async function* packets():AsyncGenerator<MediaPacket>{
  try{for await(const frame of remixed){
   expect(frame).toMatchObject({channels:destination.channels,channelLayout:destination.channelLayout,sampleRate:source.sampleRate,pts:{value:outputSamples,timeBase:{num:1n,den:BigInt(source.sampleRate)}}});
   frames.push({pts:outputSamples,samples:frame.samples});outputSamples+=BigInt(frame.samples);
   const release=resources.reserveExternalMemory(frame.samples*destination.channels*row.sampleWidth);
   try{yield encodePcm(frame,destination.codec,{maxFrameBytes:maxBytes,signal});}finally{release();}
  }}finally{await remixed.return();}
 }
 try{
  await muxFlacOutput({async write(chunk){expect(chunk.length).toBeLessThanOrEqual(maxBytes);retainedBytes+=chunk.length;expect(retainedBytes).toBeLessThanOrEqual(maxBytes);const release=resources.reserveExternalMemory(chunk.length);retainedReleases.push(release);chunks.push(Buffer.from(chunk));},async commit(){commits++;},async abort(){aborts++;}},
   {format:row.format,codec:destination.codec},{channels:destination.channels,channelLayout:destination.channelLayout,sampleRate:destination.sampleRate,channelMask:destination.channels===1?4n:3n},packets(),{sampleCount:BigInt(source.totalSamples),maxWriteBytes:257,metadataProfile:'ffmpeg-9.0.2',signal});
  expect(decodedSamples).toBe(BigInt(source.totalSamples));expect(outputSamples).toBe(decodedSamples);expect(reads).toBeGreaterThan(0);expect(commits).toBe(1);expect(aborts).toBe(0);
  return {output:Buffer.concat(chunks,retainedBytes),frames};
 }finally{await remixed.return();await decoder.close();for(const release of retainedReleases)release();releaseInput();expect(resources.allocatedBytes).toBe(0);}
}

describe('Native FLAC mono/stereo remix evidence through the real helper',()=>{
 it('pins independent Native/module provenance and complete finite matrix',()=>{
  expect(evidence.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');expect(hash(wasm)).toBe(evidence.wasmSha256);
  expect(evidence.rows).toHaveLength(60);expect(new Set(evidence.rows.map(row=>row.id)).size).toBe(60);expect(evidence.limits.nativeCalls).toBeLessThanOrEqual(64);expect(evidence.limits.sequential).toBe(true);
  expect(new Set(evidence.rows.map(row=>row.descriptors[0]!.bitsPerSample))).toEqual(new Set([16,24,32]));expect(new Set(evidence.rows.map(row=>row.descriptors[0]!.channels))).toEqual(new Set([1,2]));
 });
 it.each(evidence.rows)('$id matches Native bytes and packet timing',async row=>{
  expect(row.exitCode,'Native failures must not be presented as successful remix evidence').toBe(0);expect(row.output).not.toBeNull();
  expect(row.selectedStreamIds).toEqual([0]);expect(row.descriptors).toHaveLength(1);expect(row.outputDescriptor.channels).toBe(row.descriptors[0]!.channels===1?2:1);
  const expected=fixture(row.output!);expect(hash(expected)).toBe(row.outputSha256);
  const result=await pipeline(row);
  expect(result.output.equals(expected),row.id+' Native output bytes').toBe(true);expect(hash(result.output)).toBe(row.outputSha256);
  if(row.format==='framecrc'){
   expect(result.output.toString()).toBe(row.framecrc);const packets=parsePackets(result.output.toString());expect(packets).toEqual(row.packets);
   expect(packets.map(packet=>({pts:BigInt(packet.pts),samples:packet.duration}))).toEqual(result.frames);
   const partner=evidence.rows.find(candidate=>candidate.id===row.rawPartner);expect(partner).toBeDefined();expect(partner!.exitCode).toBe(0);
   expect(packets.reduce((sum,packet)=>sum+packet.bytes,0)).toBe(fixture(partner!.output!).length);
  }else{expect(row.sampleCount).toBe(row.descriptors[0]!.totalSamples);expect(result.output.length).toBe(row.sampleCount!*row.outputDescriptor.channels*row.sampleWidth);}
 });
});
