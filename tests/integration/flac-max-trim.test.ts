/** Native evidence for both the bounded helper and the integrated public route. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {createFlacDecoder} from '../../packages/avcodec/src/flac/decoder.js';
import {countTrimmedFlacSamples,trimFlacAudio} from '../../packages/avformat/src/flac-wave-trim.js';

interface PacketEvidence {streamId:number;pts:number;dts:number;duration:number;bytes:number;checksum:string;firstSamples:number[];lastSamples:number[]}
interface Row {
 id:string;boundary:string;variant:string;args:string[];input:string;inputSha256:string;output:string|null;outputSha256:string|null;exitCode:number;stderr:string;
 sampleCount:number;firstSamples:number[];lastSamples:number[];
 canonicalSlice:{firstSample:number;endSampleExclusive:number;exactMatch:boolean}|null;
 descriptors:{channels:number;sampleRate:number;bitsPerSample:number;totalSamples:number;channelLayout:string}[];
 packets?:PacketEvidence[];
}
interface Corpus {binarySha256:string;wasmSha256:string;rows:Row[];limits:{maxInputBytes:number;maxOutputBytes:number}}
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-trim/cases.json','utf8')) as Corpus;
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const testBound=512*1024;
function boundedBase64(value:string){
 expect(value.length).toBeLessThanOrEqual(4*Math.ceil(testBound/3));
 const bytes=Buffer.from(value,'base64');expect(bytes.length).toBeLessThanOrEqual(testBound);return bytes;
}
function checksum(bytes:Uint8Array){
 // FFmpeg framecrc uses av_adler32_update(0, ...), not zlib's initial 1.
 let a=0,b=0;for(const value of bytes){a=(a+value)%65521;b=(b+a)%65521;}
 return '0x'+((b*65536+a)>>>0).toString(16).padStart(8,'0');
}
async function pipeline(row:Row,options:{breakEarly?:boolean;abortHeld?:boolean}={}){
 const controller=new AbortController(),resources=new ResourceContext({maxResidentBytes:64*1024*1024,maxBufferBytes:65536,maxPendingPackets:2,maxCpuTimeMs:10000},controller.signal);
 const input=boundedBase64(row.input);expect(hash(input)).toBe(row.inputSha256);
 let maxRead=0,converted=0,peak=0,released=0;
 const decoder=await createFlacDecoder(module,{size:BigInt(input.length),async readAt(offset,length){maxRead=Math.max(maxRead,length);return input.subarray(Number(offset),Number(offset)+Math.min(length,13));}},{signal:controller.signal,maxReadBytes:31,maxFrameBytes:65536,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
 const planar=row.variant.startsWith('planar');
 async function* frames():AsyncIterable<AudioFrameData>{
  try{for(;;){
   const item=await decoder.next();if(item.status==='metadata')continue;if(item.status==='end')return;if(item.status!=='frame')throw Error('Unexpected decoder result');
   const bytes=item.samples*item.metadata.channels*4,release=resources.reserveExternalMemory(bytes);
   try{
    const data=new Uint8Array(bytes),view=new DataView(data.buffer),channels=item.metadata.channels;
    for(let sample=0;sample<item.samples;sample++)for(let channel=0;channel<channels;channel++){
     const index=planar?channel*item.samples+sample:sample*channels+channel;
     view.setInt32(index*4,item.planes[channel]![sample]!<<(32-item.metadata.bitsPerSample),true);
    }
    converted++;
    yield {sampleRate:item.metadata.sampleRate,channels,channelLayout:row.descriptors[0]!.channelLayout,sampleFormat:planar?'s32p':'s32',samples:item.samples,planes:planar?Array.from({length:channels},(_,channel)=>data.subarray(channel*item.samples*4,(channel+1)*item.samples*4)):[data],pts:{value:item.samplePosition,timeBase:{num:1n,den:BigInt(item.metadata.sampleRate)}}};
   }finally{release();item.release();released++;}
  }}finally{await decoder.close();}
 }
 // Native canonicalSlice is an independently measured sample interval, not a
 // claim that the helper implements -ss/-t parsing or Native rounding policy.
 const interval={startSample:BigInt(row.canonicalSlice?.firstSample??0),endSampleExclusive:BigInt(row.canonicalSlice?.endSampleExclusive??0),outputPtsSamples:0n};
 const chunks:Buffer[]=[],interleavedChunks:Buffer[]=[],packets:PacketEvidence[]=[];let bytesCollected=0;
 try{
  for await(const value of trimFlacAudio(frames(),interval,{resources,signal:controller.signal,maxFrameBytes:65536})){
   peak=Math.max(peak,resources.allocatedBytes);
   const packed=Buffer.concat(value.planes.map(plane=>Buffer.from(plane)));
   bytesCollected+=packed.length;expect(bytesCollected).toBeLessThanOrEqual(testBound);chunks.push(packed);
   expect(value.pts!.timeBase).toEqual({num:1n,den:BigInt(value.sampleRate)});
   const interleavedSample=(sample:number)=>Array.from({length:value.channels},(_,channel)=>packed.readInt32LE((planar?channel*value.samples+sample:sample*value.channels+channel)*4));
   const interleaved=Buffer.alloc(packed.length);
   for(let sample=0;sample<value.samples;sample++)for(let channel=0;channel<value.channels;channel++)interleaved.writeInt32LE(interleavedSample(sample)[channel]!,4*(sample*value.channels+channel));
   interleavedChunks.push(interleaved);
   packets.push({streamId:0,pts:Number(value.pts!.value),dts:Number(value.pts!.value),duration:value.samples,bytes:packed.length,checksum:checksum(packed),firstSamples:interleavedSample(0),lastSamples:interleavedSample(value.samples-1)});
   if(options.abortHeld){controller.abort(Error('cancel held real Wasm frame'));break;}
   if(options.breakEarly)break;
  }
 }finally{await decoder.close();}
 expect(resources.allocatedBytes).toBe(0);expect(released).toBe(converted);expect(maxRead).toBeLessThanOrEqual(31);
 return {bytes:Buffer.concat(chunks),interleaved:Buffer.concat(interleavedChunks),packets,peak,converted,count:countTrimmedFlacSamples(BigInt(row.descriptors[0]!.totalSamples),interval)};
}

describe('real Wasm FLAC → bounded trim → independent Native evidence',()=>{
 it('pins the trusted module and Native corpus identity',()=>{
  expect(hash(wasm)).toBe('d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f');expect(hash(wasm)).toBe(corpus.wasmSha256);
  expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');expect(corpus.rows).toHaveLength(64);
  expect(corpus.limits.maxInputBytes).toBeLessThanOrEqual(testBound);expect(corpus.limits.maxOutputBytes).toBeLessThanOrEqual(testBound);
 });
 for(const row of corpus.rows.filter(row=>row.variant.endsWith('-framecrc')))it(`Native sample interval ${row.id}`,async()=>{
  expect(row.exitCode).toBe(0);expect(row.output).not.toBeNull();if(row.output===null)throw Error('Missing Native bytes');
  expect(hash(boundedBase64(row.output))).toBe(row.outputSha256);if(row.sampleCount)expect(row.canonicalSlice!.exactMatch).toBe(true);
  const raw=corpus.rows.find(item=>item.boundary===row.boundary&&item.variant==='packed-raw');
  if(!raw||raw.output===null)throw Error('Missing Native packed bytes');expect(raw.exitCode).toBe(0);
  const expected=boundedBase64(raw.output);expect(hash(expected)).toBe(raw.outputSha256);
  if(!row.packets)throw Error('Missing Native packet evidence');
  const actual=await pipeline(row);
  expect(actual.interleaved).toEqual(expected);if(row.variant.startsWith('packed'))expect(actual.bytes).toEqual(expected);expect(actual.count).toBe(BigInt(row.sampleCount));
  expect(actual.packets).toEqual(row.packets.map(({streamId,pts,dts,duration,bytes,checksum,firstSamples,lastSamples})=>({streamId,pts,dts,duration,bytes,checksum,firstSamples,lastSamples})));
  expect(actual.packets.reduce((count,packet)=>count+packet.duration,0)).toBe(row.sampleCount);
  if(row.sampleCount){expect(actual.packets[0]!.firstSamples).toEqual(row.firstSamples);expect(actual.packets.at(-1)!.lastSamples).toEqual(row.lastSamples);expect(actual.peak).toBeGreaterThan(0);}
 });
 it('retains the Native rejection of planar PCM in the packed s32le muxer',()=>{
  const rejected=corpus.rows.filter(row=>row.variant==='planar-raw');expect(rejected).toHaveLength(16);
  for(const row of rejected){expect(row.exitCode).toBe(234);expect(row.stderr).toContain('s32le muxer supports only codec pcm_s32le');expect(row.output).toBe('');expect(hash(boundedBase64(row.output!))).toBe(row.outputSha256);}
 });
 it('closes real decoder leases and releases all Core reservations on consumer return and abort',async()=>{
  const row=corpus.rows.find(row=>row.id==='baseline/packed-raw');if(!row)throw Error('Missing baseline');
  for(const options of [{breakEarly:true},{abortHeld:true}]){const actual=await pipeline(row,options);expect(actual.converted).toBe(1);expect(actual.packets).toHaveLength(1);}
 });
});

describe('public Node FLAC trim against immutable Native arguments',()=>{
 const gapReason=(row:Row)=>row.variant==='planar-framecrc'?'Unsupported FLAC PCM codec: pcm_s32le_planar':row.exitCode===0&&['t-half-sample','to-half-sample'].includes(row.boundary)?'Positive FLAC output duration rounding to zero requires decoded frame boundaries':null;
 for(const row of corpus.rows.filter(row=>row.exitCode===0&&gapReason(row)===null))it(`publishes exact Native ${row.id}`,()=>{
  const root=mkdtempSync(join(tmpdir(),'edge-flac-max-trim-'));
  try{
   const input=boundedBase64(row.input);expect(hash(input)).toBe(row.inputSha256);
   writeFileSync(join(root,'in.flac'),input);
   // An existing target also verifies successful transactional replacement.
   writeFileSync(join(root,'out'),Buffer.from('previous trim publication'));
   const result=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--flac-wasm',resolve('.build/codecs/flac/edge-flac.wasm'),'--','-y',...row.args],{encoding:'utf8',timeout:20000});
   expect(result.error,row.id).toBeUndefined();expect(result.signal,row.id).toBeNull();
   expect(result.status,row.id+result.stderr).toBe(0);
   expect(JSON.parse(result.stdout)).toMatchObject({exitCode:0,outputs:['/out'],diagnostics:[]});
   if(row.output===null)throw Error('Missing Native output');
   const expected=boundedBase64(row.output),actual=readFileSync(join(root,'out'));
   expect(hash(expected)).toBe(row.outputSha256);expect(hash(actual)).toBe(row.outputSha256);expect(actual).toEqual(expected);
   expect(readdirSync(root).sort()).toEqual(['in.flac','out']);
  }finally{rmSync(root,{recursive:true,force:true});}
 },30000);
 // These are explicit backend gaps, not Native parity or skipped acceptance.
 for(const row of corpus.rows.filter(row=>row.exitCode===0&&gapReason(row)!==null))it(`reports unsupported Native-positive ${row.id} atomically`,()=>{
  const root=mkdtempSync(join(tmpdir(),'edge-flac-max-trim-gap-')),sentinel=Buffer.from('previous trim publication');
  try{
   writeFileSync(join(root,'in.flac'),boundedBase64(row.input));writeFileSync(join(root,'out'),sentinel);
   const result=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--flac-wasm',resolve('.build/codecs/flac/edge-flac.wasm'),'--','-y',...row.args],{encoding:'utf8',timeout:20000});
   expect(result.error,row.id).toBeUndefined();expect(result.signal,row.id).toBeNull();expect(result.status,row.id+result.stderr).toBe(1);
   expect(JSON.parse(result.stderr)).toMatchObject({exitCode:1,outputs:[],diagnostics:[{code:'unsupported-command',message:gapReason(row)}]});
   expect(readFileSync(join(root,'out'))).toEqual(sentinel);expect(readdirSync(root).sort()).toEqual(['in.flac','out']);
  }finally{rmSync(root,{recursive:true,force:true});}
 },30000);
 for(const row of corpus.rows.filter(row=>row.variant==='planar-raw'))it(`rejects Native-invalid ${row.id} without replacing output`,()=>{
  const root=mkdtempSync(join(tmpdir(),'edge-flac-max-trim-reject-')),sentinel=Buffer.from('previous trim publication');
  try{
   expect(row.exitCode).not.toBe(0);expect(row.stderr).toContain('s32le muxer supports only codec pcm_s32le');
   writeFileSync(join(root,'in.flac'),boundedBase64(row.input));writeFileSync(join(root,'out'),sentinel);
   const result=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--flac-wasm',resolve('.build/codecs/flac/edge-flac.wasm'),'--','-y',...row.args],{encoding:'utf8',timeout:20000});
   expect(result.error,row.id).toBeUndefined();expect(result.signal,row.id).toBeNull();expect(result.status,row.id+result.stderr).toBe(1);
   const summary=JSON.parse(result.stderr) as {exitCode:number;outputs:string[];diagnostics:{code:string}[]};
   expect(summary.exitCode).toBe(1);expect(summary.outputs).toEqual([]);expect(summary.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:'unsupported-command'})]));
   expect(readFileSync(join(root,'out'))).toEqual(sentinel);expect(readdirSync(root).sort()).toEqual(['in.flac','out']);
  }finally{rmSync(root,{recursive:true,force:true});}
 },30000);
});
