/** Node-only harness: trusted Wasm and independently captured Native bytes, never Native execution. */
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {encodePcm} from '@edge-ffmpeg/avcodec';
import type {AudioFrameData,MediaPacket} from '@edge-ffmpeg/avutil';
import {createFlacDecoder} from '../../packages/avcodec/src/flac/decoder.js';
import {compileFlacAudioFilters,processFlacAudioFilters} from '../../packages/avformat/src/flac-wave-filters.js';
import {muxFlacOutput} from '../../packages/avformat/src/flac-output.js';
import corpus from '../../compat/behavior-specs/flac-max-filters/cases.json' with {type:'json'};

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const maxFrameBytes=131072;

async function run(row:typeof corpus.rows[number]){
 if(row.output===null)throw Error('Successful Native row has no captured output');
 const input=Buffer.from(row.input,'base64'),expected=Buffer.from(row.output,'base64');
 expect(input.byteLength).toBeLessThanOrEqual(corpus.limits.maxInputBytes);expect(expected.byteLength).toBeLessThanOrEqual(corpus.limits.maxOutputBytes);
 expect(hash(input)).toBe(row.inputSha256);expect(hash(expected)).toBe(row.outputSha256);
 const abort=new AbortController(),resources=new ResourceContext({maxResidentBytes:33554432,maxBufferBytes:maxFrameBytes,maxPendingPackets:4,maxCpuTimeMs:10000},abort.signal);
 const compiled=compileFlacAudioFilters(row.filter,'s32'),descriptor=row.descriptors[0]!;
 const inputFormat=descriptor.bitsPerSample<=16?'s16':'s32';
 const plan={...compiled.plan(BigInt(descriptor.totalSamples),descriptor.sampleRate,inputFormat),...compiled.planSamples(BigInt(descriptor.totalSamples),descriptor.sampleRate,{configuredInput:true})};
 const decoder=await createFlacDecoder(module,{size:BigInt(input.length),async readAt(offset,length,signal){signal?.throwIfAborted();expect(length).toBeLessThanOrEqual(31);return input.subarray(Number(offset),Number(offset)+Math.min(length,7));}},{signal:abort.signal,maxReadBytes:31,maxFrameBytes,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
 const chunks:Uint8Array[]=[];let bytesWritten=0,commits=0,aborts=0,emitted=0n;
 const format=row.id.endsWith('/framecrc')?'framecrc':'s32le';
 async function* frames():AsyncIterable<AudioFrameData>{
  try{
   for(;;){
    const item=await decoder.next();if(item.status==='end')return;if(item.status!=='frame')continue;
    try{
     const width=inputFormat==='s16'?2:4,bytes=item.samples*item.metadata.channels*width,release=resources.reserveExternalMemory(bytes);
     try{
      expect(bytes).toBeLessThanOrEqual(maxFrameBytes);
      const packed=new Uint8Array(bytes),view=new DataView(packed.buffer),shift=width*8-item.metadata.bitsPerSample;
      for(let sample=0;sample<item.samples;sample++)for(let channel=0;channel<item.metadata.channels;channel++){
       const value=item.planes[channel]![sample]!<<shift,offset=(sample*item.metadata.channels+channel)*width;
       if(width===2)view.setInt16(offset,value,true);else view.setInt32(offset,value,true);
      }
      yield {sampleRate:item.metadata.sampleRate,channels:item.metadata.channels,channelLayout:descriptor.channelLayout,sampleFormat:inputFormat,samples:item.samples,planes:[packed],pts:{value:item.samplePosition,timeBase:{num:1n,den:BigInt(item.metadata.sampleRate)}}};
     }finally{release();}
    }finally{item.release();}
   }
  }finally{await decoder.close();}
 }
 async function* packets():AsyncIterable<MediaPacket>{
  for await(const frame of processFlacAudioFilters(frames(),compiled,{resources,signal:abort.signal,maxFrameBytes,inputFormat:{sampleRate:descriptor.sampleRate,channels:descriptor.channels,channelLayout:descriptor.channelLayout,sampleFormat:inputFormat,pts:{value:0n,timeBase:{num:1n,den:BigInt(descriptor.sampleRate)}}}})){
   expect(frame.sampleRate).toBe(plan.outputRate);expect(frame.sampleFormat).toBe(plan.sampleFormat);
   // Encoding and retained test output are caller-owned, not filter reservations.
   const release=resources.reserveExternalMemory(frame.samples*frame.channels*8);
   try{const packet=encodePcm(frame,'pcm_s32le',{maxFrameBytes,signal:abort.signal});emitted+=BigInt(frame.samples);yield packet;}finally{release();}
  }
 }
 try{
  await muxFlacOutput({async write(chunk){bytesWritten+=chunk.byteLength;expect(bytesWritten).toBeLessThanOrEqual(corpus.limits.maxOutputBytes);chunks.push(chunk.slice());},async commit(){commits++;},async abort(){aborts++;}},{format,codec:'pcm_s32le'},{channels:descriptor.channels,sampleRate:plan.outputRate,channelLayout:descriptor.channelLayout,channelMask:descriptor.channels===1?4n:3n},packets(),{sampleCount:plan.samples,maxWriteBytes:4096,signal:abort.signal,metadataProfile:'ffmpeg-9.0.2'});
  expect(aborts).toBe(0);expect(commits).toBe(1);expect(emitted).toBe(plan.samples);
  if(row.sampleCount!==undefined)expect(emitted).toBe(BigInt(row.sampleCount));
  if(row.outputSampleRate!==undefined)expect(plan.outputRate).toBe(row.outputSampleRate);
  expect(Buffer.concat(chunks).equals(expected),`${row.id}: Native output byte parity`).toBe(true);
 }finally{await decoder.close();expect(resources.allocatedBytes).toBe(0);}
}

describe('FLAC helper pipeline vs pinned independent Native filter evidence',()=>{
 it('pins the real module, reference binary and independent corpus shape',()=>{
  expect(hash(wasm)).toBe(corpus.wasmSha256);expect(corpus.wasmSha256).toBe('d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f');
  expect(corpus.reference.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
  expect(corpus.rows).toHaveLength(64);expect(new Set(corpus.rows.map(row=>row.id)).size).toBe(64);expect(corpus.limits.sequential).toBe(true);
  expect(corpus.rows.filter(row=>row.exitCode===0)).toHaveLength(60);expect(Object.keys(corpus.sourcePins)).toHaveLength(6);
 });
 for(const row of corpus.rows){
  if(row.exitCode===0)it(`matches Native payload/count/rate/packet framing: ${row.id}`,async()=>{await run(row);});
  else it(`rejects Native-invalid syntax before decoder or output creation: ${row.id}`,()=>{
   expect(row.expectedOutcome).toBe('error');expect(row.exitCode).not.toBe(0);expect(()=>compileFlacAudioFilters(row.filter,'s32')).toThrow();
  });
 }
});

describe('public FLAC filters through the real Node filesystem',()=>{
 for(const row of corpus.rows)it(`Native evidence through public exec: ${row.id}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'edge-flac-filters-'));
  try{
   const input=Buffer.from(row.input,'base64');expect(hash(input)).toBe(row.inputSha256);
   await writeFile(join(root,'in.flac'),input);
   const filesystem=await createNodeFileSystem({root,maxReadBytes:maxFrameBytes,maxWriteBytes:maxFrameBytes});
   const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend({flac:{module}}),budget:{maxResidentBytes:33554432,maxBufferBytes:maxFrameBytes,maxPendingPackets:4,maxCpuTimeMs:10000}});
   // -fs is the Native generator's safety ceiling, above every captured output.
   // This driver enforces that ceiling on the captured evidence instead: the
   // virtual CLI does not implement file-size truncation.
   if(row.output!==null)expect(Buffer.from(row.output,'base64').length).toBeLessThan(524289);
   const args=row.args.filter((arg,index,argv)=>arg!=='-fs'&&argv[index-1]!=='-fs');
   const result=await ffmpeg.exec(args);
   if(row.exitCode!==0){
    expect(result.exitCode).not.toBe(0);expect(result.outputs).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(['in.flac']);return;
   }
   const descriptor=row.descriptors[0]!,format=descriptor.bitsPerSample<=16?'s16':'s32';
   if(compileFlacAudioFilters(row.filter,'s32').plan(BigInt(descriptor.totalSamples),descriptor.sampleRate,format).requiresScalarRounding){
    expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/requires -cpuflags 0/);
    expect(result.outputs).toEqual([]);expect((await readdir(root)).sort()).toEqual(['in.flac']);return;
   }
   expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(0);expect(result.outputs).toEqual(['/out']);
   if(row.output===null)throw Error('Successful Native row has no captured output');
   const output=await readFile(join(root,'out'));
   expect(hash(output)).toBe(row.outputSha256);expect(output.equals(Buffer.from(row.output,'base64'))).toBe(true);
   expect((await readdir(root)).sort()).toEqual(['in.flac','out']);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
