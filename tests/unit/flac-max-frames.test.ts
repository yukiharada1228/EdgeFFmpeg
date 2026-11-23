import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {ResourceContext} from '../../packages/core/src/resources.js';
import {createFlacDecoder} from '../../packages/avcodec/src/flac/decoder.js';
import type {FlacDecoderInput} from '../../packages/avcodec/src/flac/decoder-types.js';
import {decodeFlacAudioFrames,prepareFlacAudioFrames} from '../../packages/avformat/src/flac-wave-frames.js';

const decoderBytes=16777216;
const module=new WebAssembly.Module(readFileSync('.build/codecs/flac/edge-flac.wasm'));
// Existing independent Native evidence is sufficient for decoder ownership tests;
// the bridge's separate Native corpus is owned by the oracle worker.
const corpus=JSON.parse(readFileSync('.build/flac-investigation/native-cases.json','utf8')) as {
 rows:{id:string;flac:string;samples:number;bits:number;channels:number}[];
};
const row=corpus.rows.find(item=>item.bits===16&&item.channels===2&&item.samples>192);
if(!row)throw Error('Missing multiframe stereo Native FLAC fixture');
const inputBytes=Buffer.from(row.flac,'base64');
function context(resident=decoderBytes+65536,buffer=65536,controller=new AbortController()){
 return {controller,resources:new ResourceContext({maxResidentBytes:resident,maxBufferBytes:buffer,maxCpuTimeMs:10000,maxPendingPackets:4},controller.signal)};
}
function reader():FlacDecoderInput{
 return {size:BigInt(inputBytes.length),async readAt(offset,length){
  expect(length).toBeLessThanOrEqual(31);
  return inputBytes.subarray(Number(offset),Number(offset)+Math.min(length,7));
 }};
}

// Retain decoder-level ownership regressions alongside the bridge coverage below.
describe('FLAC AudioFrameData bridge decoder ownership prerequisites',()=>{
 it('reserves exactly one fixed decoder and refuses a second under the same Core budget',async()=>{
  const {resources}=context(decoderBytes),options={maxReadBytes:31,reserveExternalMemory:(bytes:number)=>resources.reserveExternalMemory(bytes)};
  const decoder=await createFlacDecoder(module,reader(),options);
  try{
   expect(resources.allocatedBytes).toBe(decoderBytes);
   await expect(createFlacDecoder(module,reader(),options)).rejects.toThrow('Memory budget exceeded');
   expect(resources.allocatedBytes).toBe(decoderBytes);
  }finally{await decoder.close();}
  expect(resources.allocatedBytes).toBe(0);
 });

 it('does not allocate a decoder or call the provider when already aborted',async()=>{
  const {resources,controller}=context(),reason=new Error('cancelled before opening');let reads=0;
  controller.abort(reason);
  await expect(createFlacDecoder(module,{size:1n,async readAt(){reads++;return new Uint8Array(1);}},{signal:controller.signal,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)})).rejects.toBe(reason);
  expect(reads).toBe(0);expect(resources.allocatedBytes).toBe(0);
 });

 it('exposes metadata before a borrowed frame and never advances with an outstanding loan',async()=>{
  const {resources}=context(),decoder=await createFlacDecoder(module,reader(),{maxReadBytes:31,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  try{
   expect(decoder.metadata).toBeNull();
   const metadata=await decoder.next();expect(metadata.status).toBe('metadata');
   expect(metadata.metadata.channels).toBe(2);expect(metadata.metadata.bitsPerSample).toBe(16);
   let frame=await decoder.next();
   while(frame.status==='metadata')frame=await decoder.next();
   expect(frame.status).toBe('frame');
   if(frame.status!=='frame')throw Error('Expected borrowed PCM frame');
   expect(frame.samplePosition).toBe(0n);expect(frame.planes).toHaveLength(2);
   await expect(decoder.next()).rejects.toThrow('unreleased');
   frame.release();frame.release();expect(()=>frame.planes).toThrow('released');
   let next=await decoder.next();
   while(next.status==='metadata')next=await decoder.next();
   expect(next.status).toBe('frame');
   if(next.status==='frame'){
    expect(next.samplePosition).toBe(BigInt(frame.samples));
    await decoder.close();expect(()=>next.planes).toThrow('released');
   }
  }finally{await decoder.close();}
  expect(resources.allocatedBytes).toBe(0);
 });

 it('accounts packed output concurrently with the decoder rather than treating Wasm as free',async()=>{
  const {resources}=context(decoderBytes+64,64),decoder=await createFlacDecoder(module,reader(),{maxReadBytes:31,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  try{
   const packed=resources.allocate(64);
   try{
    expect(resources.allocatedBytes).toBe(decoderBytes+64);
    expect(()=>resources.allocate(1)).toThrow('Memory budget exceeded');
   }finally{packed.release();}
   expect(resources.allocatedBytes).toBe(decoderBytes);
  }finally{await decoder.close();}
  expect(resources.allocatedBytes).toBe(0);
 });

 it('rejects oversized decoded frames and releases the fixed reservation',async()=>{
  const {resources}=context(),decoder=await createFlacDecoder(module,reader(),{maxReadBytes:31,maxFrameBytes:1,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  try{
   // STREAMINFO itself may reject an impossible decoded-frame limit before
   // the decoder yields metadata; no PCM frame may escape either way.
   await expect((async()=>{
    for(let step=0;step<32;step++){
     const result=await decoder.next();
     if(result.status==='frame'){result.release();throw Error('Unexpected PCM frame');}
     if(result.status==='end')throw Error('Unexpected successful end');
    }
    throw Error('Metadata did not terminate');
   })()).rejects.toThrow('decode rejected');
  }finally{await decoder.close();}
  expect(resources.allocatedBytes).toBe(0);
 });

 it.each(['resolve','reject'] as const)('observes late provider %s after cancellation and returns Core ownership to zero',async action=>{
  const {resources,controller}=context(),reason=new Error('cancel stalled provider');
  let entered!:()=>void,resolve!:(bytes:Uint8Array)=>void,reject!:(reason:Error)=>void;
  const started=new Promise<void>(done=>{entered=done;});
  const decoder=await createFlacDecoder(module,{size:BigInt(inputBytes.length),readAt(){entered();return new Promise<Uint8Array>((done,fail)=>{resolve=done;reject=fail;});}},{signal:controller.signal,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  const next=decoder.next(),observed=expect(next).rejects.toBe(reason);
  await started;controller.abort(reason);await observed;await decoder.close();
  expect(resources.allocatedBytes).toBe(0);expect(decoder.bytesRead).toBe(0n);
  if(action==='resolve')resolve(inputBytes);else reject(new Error('late provider failure'));
  await new Promise<void>(done=>setTimeout(done,0));
  expect(resources.allocatedBytes).toBe(0);expect(decoder.bytesRead).toBe(0n);
 });
});

describe('FLAC AudioFrameData bridge Core ownership',()=>{
 it('opens lazily, caches prepare and retains one decoder without consuming PCM',async()=>{
  const {resources,controller}=context();let reads=0;
  const source=reader(),frames=decodeFlacAudioFrames(module,{size:source.size,async readAt(offset,length,signal){reads++;return source.readAt(offset,length,signal);}},{resources,signal:controller.signal,maxFrameBytes:65536,maxReadBytes:31});
  expect(reads).toBe(0);expect(frames.metadata).toBeNull();
  const preparing=frames.prepare();expect(frames.prepare()).toBe(preparing);
  try{
   const metadata=await preparing;
   expect(metadata).toMatchObject({channels:2,bitsPerSample:16,sampleFormat:'s16',channelLayout:'stereo',channelMask:3n,timeBase:{num:1n,den:BigInt(metadata.sampleRate)}});
   expect(frames.metadata).toBe(metadata);expect(resources.allocatedBytes).toBe(decoderBytes+31);
   const first=await frames.next();expect(first.done).toBe(false);
   if(first.done)throw Error('Missing first packed frame');
   expect(first.value.pts?.value).toBe(0n);
   expect(resources.allocatedBytes).toBe(decoderBytes+31+first.value.planes[0]!.byteLength);
  }finally{await frames.close();await frames.close();}
  expect(resources.allocatedBytes).toBe(0);expect((await frames.next()).done).toBe(true);
 });

 it('splits frames to the Core buffer bound with contiguous absolute PTS',async()=>{
  const {resources,controller}=context(decoderBytes+65536,64);
  const frames=await prepareFlacAudioFrames(module,reader(),{resources,signal:controller.signal,maxFrameBytes:65536,maxReadBytes:31});
  let samples=0n,chunks=0;
  try{for await(const frame of frames){
   expect(frame.pts).toEqual({value:samples,timeBase:{num:1n,den:BigInt(frame.sampleRate)}});
   expect(frame.sampleFormat).toBe('s16');expect(frame.planes).toHaveLength(1);
   expect(frame.planes[0]!.length).toBe(frame.samples*frame.channels*2);
   expect(frame.planes[0]!.length).toBeLessThanOrEqual(64);
   expect(resources.allocatedBytes).toBe(decoderBytes+31+frame.planes[0]!.length);
   samples+=BigInt(frame.samples);chunks++;
  }}finally{await frames.close();}
  expect(samples).toBe(BigInt(row.samples));expect(chunks).toBeGreaterThan(2);expect(resources.allocatedBytes).toBe(0);
 });

 it.each(['return','throw','close'] as const)('releases a live packed loan on %s',async action=>{
  const {resources,controller}=context(),frames=decodeFlacAudioFrames(module,reader(),{resources,signal:controller.signal,maxFrameBytes:65536,maxReadBytes:31});
  await frames.next();expect(resources.allocatedBytes).toBeGreaterThan(decoderBytes+31);
  if(action==='throw'){const reason=Error('consumer failure');await expect(frames.throw!(reason)).rejects.toBe(reason);}
  else if(action==='return')await frames.return!();else await frames.close();
  expect(resources.allocatedBytes).toBe(0);await frames.close();
 });

 it.each(['option','resource'] as const)('releases a live packed loan on independent %s cancellation',async source=>{
  const {resources,controller}=context(),option=new AbortController(),reason=Error('bridge cancelled');
  const frames=decodeFlacAudioFrames(module,reader(),{resources,signal:option.signal,maxFrameBytes:65536,maxReadBytes:31});
  await frames.next();(source==='option'?option:controller).abort(reason);
  await expect(frames.next()).rejects.toBe(reason);await frames.close();expect(resources.allocatedBytes).toBe(0);
 });

 it.each(['resolve','reject'] as const)('detaches stalled bridge prepare and observes late %s',async action=>{
  const {resources,controller}=context(),reason=Error('cancel bridge prepare');
  let entered!:()=>void,resolve!:(bytes:Uint8Array)=>void,reject!:(reason:Error)=>void;
  const started=new Promise<void>(done=>{entered=done;});
  const frames=decodeFlacAudioFrames(module,{size:BigInt(inputBytes.length),readAt(){entered();return new Promise<Uint8Array>((done,fail)=>{resolve=done;reject=fail;});}},{resources,signal:controller.signal,maxFrameBytes:65536,maxReadBytes:31});
  const next=frames.next(),observed=expect(next).rejects.toBe(reason);
  await started;await expect(frames.next()).rejects.toThrow('Concurrent');
  controller.abort(reason);await observed;await frames.close();expect(resources.allocatedBytes).toBe(0);
  if(action==='resolve')resolve(inputBytes.subarray(0,7));else reject(Error('late bridge provider rejection'));
  await new Promise<void>(done=>setTimeout(done,0));expect(resources.allocatedBytes).toBe(0);
 });

 it('fails decoder and packed budget admission without leaking reservations',async()=>{
  for(const [resident,buffer,maxFrameBytes] of [[decoderBytes,65536,65536],[decoderBytes+31,65536,65536],[decoderBytes+65536,65536,1]] as const){
   const {resources,controller}=context(resident,buffer),frames=decodeFlacAudioFrames(module,reader(),{resources,signal:controller.signal,maxFrameBytes,maxReadBytes:31});
   let failure:unknown;
   try{await frames.next();}catch(error){failure=error;}
   expect(failure).toBeInstanceOf(Error);
   // Failed decoder construction may also reject close with its opening error.
   await frames.close().catch(error=>{expect(error).toBe(failure);});
   expect(resources.allocatedBytes).toBe(0);
  }
 });

 it('does not read or reserve for an already aborted bridge',async()=>{
  const {resources,controller}=context(),reason=Error('already cancelled');controller.abort(reason);let reads=0;
  const frames=decodeFlacAudioFrames(module,{size:1n,async readAt(){reads++;return new Uint8Array(1);}},{resources,signal:controller.signal,maxFrameBytes:65536});
  await expect(frames.prepare()).rejects.toBe(reason);await frames.close();expect(reads).toBe(0);expect(resources.allocatedBytes).toBe(0);
 });
});
