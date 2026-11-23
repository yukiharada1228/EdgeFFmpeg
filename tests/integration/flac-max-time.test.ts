// Native is an independent, captured development oracle, never a runtime fallback.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {parseArgv} from '@edge-ffmpeg/cli';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {createFlacDecoder} from '../../packages/avcodec/src/flac/decoder.js';
import type {FlacDecoder} from '../../packages/avcodec/src/flac/decoder-types.js';
import {compileFlacTimePolicy,resolveFlacTimePolicy} from '../../packages/avformat/src/flac-wave-time.js';
import {trimFlacAudio} from '../../packages/avformat/src/flac-wave-trim.js';
import corpus from '../../compat/behavior-specs/flac-max-time/cases.json' with {type:'json'};

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const budget={maxResidentBytes:16842752,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:10000};
const unsupported=new Set(['ss-input','repeat-ss-t-input','ss-beyond-eof-input','repeat-to-range-input','mixed-input-output','t-tiny-output']);
type Row=typeof corpus.rows[number];

// Test-only bounded s16 packing; producer releases each decoder lease in finally.
async function* frames(decoder:FlacDecoder,resources:ResourceContext):AsyncGenerator<AudioFrameData>{
 for(;;){
  const item=await decoder.next();if(item.status==='end')return;if(item.status!=='frame')continue;
  let release:(()=>void)|undefined;
  try{
   expect(item.metadata.bitsPerSample).toBe(16);const bytes=item.samples*item.metadata.channels*2;
   expect(bytes).toBeLessThanOrEqual(budget.maxBufferBytes);release=resources.reserveExternalMemory(bytes);
   const data=new Uint8Array(bytes),view=new DataView(data.buffer),planes=item.planes;
   for(let sample=0;sample<item.samples;sample++)for(let channel=0;channel<planes.length;channel++)view.setInt16((sample*planes.length+channel)*2,planes[channel]![sample]!,true);
   yield {sampleRate:item.metadata.sampleRate,channels:item.metadata.channels,channelLayout:'stereo',sampleFormat:'s16',samples:item.samples,planes:[data],pts:{value:item.samplePosition,timeBase:{num:1n,den:BigInt(item.metadata.sampleRate)}}};
  }finally{release?.();item.release();}
 }
}
function nativePcm(row:Row):Buffer {
 const bytes=Buffer.from(row.output!,'base64');
 if(row.variant==='raw')return bytes;
 expect(bytes.toString('ascii',0,4)).toBe('RIFF');expect(bytes.toString('ascii',8,12)).toBe('WAVE');
 for(let at=12;at+8<=bytes.length;){const size=bytes.readUInt32LE(at+4);expect(at+8+size).toBeLessThanOrEqual(bytes.length);if(bytes.toString('ascii',at,at+4)==='data')return bytes.subarray(at+8,at+8+size);at+=8+size+(size&1);}
 throw Error('Native WAV has no PCM chunk');
}
async function run(row:Row,unknown=false){
 const input=Buffer.from(row.input,'base64'),abort=new AbortController(),resources=new ResourceContext(budget,abort.signal);
 const policy=compileFlacTimePolicy(parseArgv(row.args)),descriptor=row.descriptors[0]!;
 const range=resolveFlacTimePolicy(policy,descriptor.sampleRate,unknown?null:BigInt(descriptor.totalSamples));
 let maxRead=0;const decoder=await createFlacDecoder(module,{size:BigInt(input.length),async readAt(at,length){maxRead=Math.max(maxRead,length);return input.subarray(Number(at),Number(at)+Math.min(7,length));}},{signal:abort.signal,maxReadBytes:31,reserveExternalMemory:n=>resources.reserveExternalMemory(n)});
 const chunks:Buffer[]=[],packets:{pts:number;duration:number;bytes:number}[]=[];
 try{
  for await(const frame of trimFlacAudio(frames(decoder,resources),range,{resources,signal:abort.signal,maxFrameBytes:4096})){
   expect(frame.pts).not.toBeNull();expect(frame.pts!.timeBase).toEqual({num:1n,den:BigInt(descriptor.sampleRate)});
   packets.push({pts:Number(frame.pts!.value),duration:frame.samples,bytes:frame.planes[0]!.byteLength});chunks.push(Buffer.from(frame.planes[0]!));
  }
 }finally{await decoder.close();expect(resources.allocatedBytes).toBe(0);}
 expect(maxRead).toBeLessThanOrEqual(31);return {pcm:Buffer.concat(chunks),packets,range};
}

it('pins trusted Wasm and independently captured bounded Native corpus identities',()=>{
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 expect(corpus.reference.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');
 expect(hash(wasm)).toBe(corpus.wasmSha256);expect(corpus.rows).toHaveLength(63);expect(corpus.limits.nativeCalls).toBeLessThanOrEqual(64);
 expect(new Set(corpus.rows.map(row=>row.id)).size).toBe(corpus.rows.length);
 for(const row of corpus.rows){const input=Buffer.from(row.input,'base64');expect(input.length).toBeLessThanOrEqual(512*1024);expect(hash(input)).toBe(row.inputSha256);if(row.output!==null){const output=Buffer.from(row.output,'base64');expect(output.length).toBeLessThanOrEqual(512*1024);expect(hash(output)).toBe(row.outputSha256);}}
});

for(const row of corpus.rows)it(`real decoder/time/trim pipeline versus Native ${row.id}`,async()=>{
 const policy=()=>compileFlacTimePolicy(parseArgv(row.args));
 if(row.exitCode!==0){expect(policy).toThrow(expect.objectContaining({code:'invalid-time'}));return;}
 if(unsupported.has(row.scenario)){
  // Proven Native-success gaps are assertions, not skips or silently empty output.
  const resolve=()=>resolveFlacTimePolicy(policy(),row.descriptors[0]!.sampleRate,BigInt(row.descriptors[0]!.totalSamples));
  expect(resolve).toThrow(expect.objectContaining({code:'unsupported-command'}));return;
 }
 const result=await run(row);expect(result.pcm.length/4).toBe(row.sampleCount);
 if(row.variant==='framecrc'){
  const packets=row.framecrc!.split('\n').filter(line=>/^\d+,/.test(line)).map(line=>{const fields=line.split(',').map(value=>value.trim());return {pts:Number(fields[2]),duration:Number(fields[3]),bytes:Number(fields[4])};});
  expect(result.packets).toEqual(packets);
 }else{
  const expected=nativePcm(row);expect(result.pcm.equals(expected)).toBe(true);expect(hash(result.pcm)).toBe(row.pcmSha256);
  if(row.canonicalSlice!==null&&row.canonicalSlice!==undefined)expect(result.range).toMatchObject({startSample:BigInt(row.canonicalSlice.firstSample),endSampleExclusive:BigInt(row.canonicalSlice.endSampleExclusive)});
 }
});

it('keeps unknown EOF selection identical to Native without treating STREAMINFO zero as empty',async()=>{
 const row=corpus.rows.find(row=>row.id==='ss-output/raw')!;
 const result=await run(row,true);expect(result.range.endSampleExclusive).toBeNull();expect(result.pcm.equals(nativePcm(row))).toBe(true);
});

it('cancels a stalled real decoder read, observes late rejection and returns Core owned bytes to zero',async()=>{
 const row=corpus.rows[0]!,input=Buffer.from(row.input,'base64'),abort=new AbortController(),resources=new ResourceContext(budget,abort.signal),reason=Error('cancel timed FLAC');
 let entered!:()=>void,rejectRead!:(error:unknown)=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const decoder=await createFlacDecoder(module,{size:BigInt(input.length),readAt(at,length){
  if(at>=42n){entered();return new Promise<Uint8Array>((_resolve,reject)=>{rejectRead=reject;});}
  return Promise.resolve(input.subarray(Number(at),Number(at)+Math.min(7,length)));
 }},{signal:abort.signal,maxReadBytes:31,reserveExternalMemory:n=>resources.reserveExternalMemory(n)});
 const range=resolveFlacTimePolicy(compileFlacTimePolicy(parseArgv(row.args)),8000,257n);
 const iterator=trimFlacAudio(frames(decoder,resources),range,{resources,signal:abort.signal,maxFrameBytes:4096})[Symbol.asyncIterator]();
 try{const task=iterator.next(),rejected=expect(task).rejects.toBe(reason);await ready;abort.abort(reason);await rejected;rejectRead(Error('late read failure'));await new Promise<void>(resolve=>setTimeout(resolve,0));}
 finally{await iterator.return?.();await decoder.close();}expect(resources.allocatedBytes).toBe(0);
});

it('rejects a real decoder reservation above available Core capacity without leaking memory',async()=>{
 const row=corpus.rows[0]!,input=Buffer.from(row.input,'base64'),abort=new AbortController(),resources=new ResourceContext({...budget,maxResidentBytes:16777215},abort.signal);let reads=0;
 await expect(createFlacDecoder(module,{size:BigInt(input.length),async readAt(at,length){reads++;return input.subarray(Number(at),Number(at)+length);}},{signal:abort.signal,reserveExternalMemory:n=>resources.reserveExternalMemory(n)})).rejects.toThrow(/budget/i);
 expect(reads).toBe(0);expect(resources.allocatedBytes).toBe(0);
});

// Exercise the public planner/backend/muxer as well as the helper-level decoder
// driver above. Native failure statuses are not claimed as exit-code parity.
for(const row of corpus.rows)it(`public FLAC time command versus Native ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),sentinel=Buffer.from('previous complete output');
 let published:Buffer=sentinel,opens=0,commits=0,aborts=0,maxRead=0,maxWrite=0;
 const chunks:Uint8Array[]=[];
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),budget:{...budget,maxResidentBytes:33554432,maxBufferBytes:65536},
  filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,length){maxRead=Math.max(maxRead,length);return input.subarray(Number(at),Number(at)+Math.min(7,length));}};},
   async openWrite(){opens++;return {async write(bytes){maxWrite=Math.max(maxWrite,bytes.length);expect(published).toBe(sentinel);chunks.push(bytes.slice());},async commit(){commits++;published=Buffer.concat(chunks);},async abort(){aborts++;chunks.length=0;}};}}});
 const result=await ffmpeg.exec(row.args);
 expect(maxRead).toBeLessThanOrEqual(65536);expect(maxWrite).toBeLessThanOrEqual(65536);
 if(unsupported.has(row.scenario)||row.exitCode!==0){
  expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code).toBe(unsupported.has(row.scenario)?'unsupported-command':'invalid-time');
  expect(result.outputs).toEqual([]);expect(opens).toBe(0);expect(commits).toBe(0);expect(aborts).toBe(0);expect(published).toBe(sentinel);return;
 }
 expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(result.diagnostics).toEqual([]);expect(result.outputs).toEqual(['/out']);
 expect(opens).toBe(1);expect(commits).toBe(1);expect(aborts).toBe(0);
 expect(published.equals(Buffer.from(row.output!,'base64')),row.id).toBe(true);expect(hash(published)).toBe(row.outputSha256);
});

it.each(['write-failure','cancel-write'] as const)('preserves the previous public timed output after %s',async mode=>{
 const row=corpus.rows.find(row=>row.id==='ss-output/raw')!,input=Buffer.from(row.input,'base64');
 const sentinel=Buffer.from('previous complete output'),controller=new AbortController(),reason=Error(mode);
 let published:Buffer=sentinel,commits=0,aborts=0,writes=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),budget:{...budget,maxResidentBytes:33554432,maxBufferBytes:65536},
  filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+Math.min(7,length));}};},
   async openWrite(){return {async write(){writes++;expect(published).toBe(sentinel);if(mode==='cancel-write')controller.abort(reason);throw reason;},async commit(){commits++;published=Buffer.alloc(0);},async abort(){aborts++;}};}}});
 const result=await ffmpeg.exec(row.args,{signal:controller.signal});
 expect(result.exitCode).not.toBe(0);expect(result.outputs).toEqual([]);expect(writes).toBe(1);expect(commits).toBe(0);expect(aborts).toBe(1);expect(published).toBe(sentinel);
 if(mode==='cancel-write')expect(result.diagnostics[0]?.code).toBe('cancelled');
});
