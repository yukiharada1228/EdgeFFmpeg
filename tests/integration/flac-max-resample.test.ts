/** Development-only independent Native evidence; never invokes Native. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {countResampledFlacSamples,resampleFlacAudio} from '../../packages/avformat/src/flac-wave-resample.js';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {createFlacDecoder} from '../../packages/avcodec/src/flac/decoder.js';

import originalCorpus from '../../compat/behavior-specs/flac-max-resample/cases.json' with {type:'json'};
import corpus from '../../compat/behavior-specs/flac-max-resample/scalar.json' with {type:'json'};

const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const maxFrameBytes=512;

it('pins independent scalar Native evidence and the actual trusted decoder module',()=>{
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 expect(hash(wasm)).toBe(corpus.wasmSha256);
 expect(corpus.wasmSha256).toBe('d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f');
 expect(corpus.limits.sequential).toBe(true);
 expect(corpus.limits.actualNativeCalls).toBe(60);
 expect(corpus.referenceOptions).toEqual(['-cpuflags','0']);
 expect(hash(readFileSync('compat/behavior-specs/flac-max-resample/cases.json'))).toBe(corpus.sourceCorpusSha256);
 expect(corpus.fingerprint).toBe('a8a9a5f0ae8e4c15ec98cf0cb74ac547165490ff6f87fe0392964a3179d7ce0a');
});

// Independent Native -cpuflags 0 evidence defines exact scalar parity.
for(const row of corpus.rows.filter(row=>row.variant==='s16le'))it(`Core-accounted scalar helper matches pinned Native PCM and finite drain: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),expected=Buffer.from(row.output,'base64');
 expect(input.length).toBeLessThanOrEqual(524288);expect(expected.length).toBeLessThanOrEqual(524288);
 expect(hash(input)).toBe(row.inputSha256);expect(hash(expected)).toBe(row.outputSha256);
 expect(row.exitCode).toBe(0);expect(row.eofDrain).toBe(true);
 const controller=new AbortController(),resources=new ResourceContext({maxResidentBytes:33554432,maxBufferBytes:maxFrameBytes,maxPendingPackets:4,maxCpuTimeMs:10000},controller.signal);
 const decoder=await createFlacDecoder(module,{size:BigInt(input.length),async readAt(offset,length){expect(length).toBeLessThanOrEqual(31);return input.subarray(Number(offset),Number(offset)+Math.min(length,7));}},{signal:controller.signal,maxReadBytes:31,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
 const parts:Buffer[]=[];let received=0n,emitted=0n;
 const sourceFormat='s16',targetFormat='s16';
 async function* decoded():AsyncIterable<AudioFrameData>{
  for(;;){
   const item=await decoder.next();if(item.status==='end')return;if(item.status!=='frame')continue;
   try{
    const {channels,sampleRate,bitsPerSample}=item.metadata;
    expect(bitsPerSample).toBe(16);expect(item.samplePosition).toBe(received);
    for(let at=0;at<item.samples;at+=17){
     const samples=Math.min(17,item.samples-at),release=resources.reserveExternalMemory(samples*channels*2);
     try{
      const packed=new Uint8Array(samples*channels*2),view=new DataView(packed.buffer);
      for(let sample=0;sample<samples;sample++)for(let channel=0;channel<channels;channel++)view.setInt16((sample*channels+channel)*2,item.planes[channel]![at+sample]!,true);
      yield {samples,channels,sampleRate,sampleFormat:sourceFormat,channelLayout:channels===2?'stereo':'mono',planes:[packed],pts:{value:received+BigInt(at),timeBase:{num:1n,den:BigInt(sampleRate)}}};
     }finally{release();}
    }
    received+=BigInt(item.samples);
   }finally{item.release();}
  }
 }
 try{
  for await(const output of resampleFlacAudio(decoded(),row.outputSampleRate,targetFormat,{resources,maxFrameBytes,signal:controller.signal})){
   expect(output.pts).toEqual({value:emitted,timeBase:{num:1n,den:BigInt(row.outputSampleRate)}});
   expect(resources.allocatedBytes).toBeGreaterThan(16777216);
   expect(output.planes[0]!.length).toBeLessThanOrEqual(maxFrameBytes);
   parts.push(Buffer.from(output.planes[0]!));emitted+=BigInt(output.samples);
  }
  const descriptor=row.descriptors[0]!;
  expect(emitted).toBe(BigInt(row.sampleCount));
  expect(emitted).toBe(countResampledFlacSamples(received,descriptor.sampleRate,row.outputSampleRate));
  expect(hash(Buffer.concat(parts)),row.id+' recorded Native PCM hash').toBe(row.outputSha256);
 }finally{await decoder.close();expect(resources.allocatedBytes).toBe(0);}
});

type Row=typeof corpus.rows[number];
const budget={maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000};
function publicRun(row:Row,mode='normal'){
 const input=Buffer.from(row.input,'base64'),sentinel=Buffer.from('previous-resample-output'),controller=new AbortController();
 let published=sentinel,commits=0,aborts=0,opens=0,maxRead=0,maxWrite=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module,maxReadBytes:31}}),budget:{...budget,maxResidentBytes:mode==='budget'?65536:budget.maxResidentBytes},filesystem:{
  async outputExists(){return false;},
  async openRead(){return {size:BigInt(input.length),async readAt(at,length){maxRead=Math.max(maxRead,length);return input.subarray(Number(at),Number(at)+Math.min(length,7));}};},
  async openWrite(){opens++;const chunks:Buffer[]=[];return {async write(bytes){maxWrite=Math.max(maxWrite,bytes.length);if(mode==='write')throw Error('injected resample write');chunks.push(Buffer.from(bytes));if(mode==='cancel')controller.abort(Error('cancel resample write'));},async commit(){if(mode==='commit')throw Error('injected resample commit');commits++;published=Buffer.concat(chunks);},async abort(){aborts++;chunks.length=0;}};},
 }});
 return {task:()=>ffmpeg.exec(row.args,{signal:controller.signal}),sentinel,get published(){return published;},get commits(){return commits;},get aborts(){return aborts;},get opens(){return opens;},get maxRead(){return maxRead;},get maxWrite(){return maxWrite;}};
}

it('preserves unpinned evidence and diagnoses exactly 24 scalar profile output differences',()=>{
 expect(corpus.rows).toHaveLength(60);expect(new Set(corpus.rows.map(row=>row.id)).size).toBe(60);
 expect(new Set(corpus.rows.map(row=>row.variant))).toEqual(new Set(['s16le','wav','framecrc']));
 expect(originalCorpus.invocationPrefix).not.toContain('-cpuflags');
 const differences:typeof corpus.rows=[];
 for(const row of corpus.rows){
  const original=originalCorpus.rows.find(original=>original.id===row.id)!;
  expect(original,row.id).toBeDefined();expect(row.args.slice(0,2),row.id).toEqual(['-cpuflags','0']);
  expect(row.args.slice(2),row.id).toEqual(original.args);
  expect(row.input,row.id).toBe(original.input);expect(row.inputSha256,row.id).toBe(original.inputSha256);
  expect(row.sampleCount,row.id).toBe(original.sampleCount);expect(row.exitCode,row.id).toBe(original.exitCode);
  expect(hash(Buffer.from(row.output,'base64')),row.id).toBe(row.outputSha256);
  if(row.outputSha256!==original.outputSha256){
   differences.push(row);expect(row.sourceId).toMatch(/^ramp-257-/);
   expect(row.outputSampleRate,row.id).not.toBe(row.descriptors[0]!.sampleRate);
   expect(Buffer.from(row.output,'base64').equals(Buffer.from(original.output,'base64')),row.id).toBe(false);
   if(row.variant==='framecrc'){
    expect(row.packets?.map(packet=>packet.checksum),row.id).not.toEqual(original.packets?.map(packet=>packet.checksum));
    expect(row.packets?.map(packet=>[packet.streamId,packet.dts,packet.pts,packet.duration,packet.bytes]),row.id).toEqual(original.packets?.map(packet=>[packet.streamId,packet.dts,packet.pts,packet.duration,packet.bytes]));
   }else expect(row.pcmSha256,row.id).not.toBe(original.pcmSha256);
  }
 }
 expect(differences).toHaveLength(24);
 for(const variant of ['s16le','wav','framecrc'])expect(differences.filter(row=>row.variant===variant)).toHaveLength(8);
 expect(new Set(differences.map(row=>row.sourceId+'/'+row.outputSampleRate)).size).toBe(8);
});
function schedulingGap(row:Row){return row.variant==='framecrc'&&row.outputSampleRate!==row.descriptors[0]!.sampleRate;}
// Explicit unsupported acceptance, not parity: the backend cannot preserve
// Native's resampled framecrc packet schedule. Never silently omit these rows.
for(const row of corpus.rows)it(`public scalar Node backend ${schedulingGap(row)?'explicitly rejects unsupported framecrc scheduling':'matches pinned scalar Native bytes'}: ${row.id}`,async()=>{
 const run=publicRun(row),result=await run.task();
 if(schedulingGap(row)){expect(result.exitCode).not.toBe(0);expect(result.diagnostics).toContainEqual({code:'unsupported-command',message:'FLAC resampled framecrc/frame limits require Native packet scheduling'});expect(run.commits).toBe(0);expect(run.published).toEqual(run.sentinel);return;}
 expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(row.exitCode);
 expect(run.commits).toBe(1);expect(run.aborts).toBe(0);expect(run.maxRead).toBeLessThanOrEqual(31);expect(run.maxWrite).toBeLessThanOrEqual(65536);
 expect(hash(run.published),row.id+' recorded Native output hash').toBe(row.outputSha256);
});

for(const mode of ['normal','write','commit','cancel','budget'])it(`public resampling keeps output atomic and Core ownership balanced: ${mode}`,async()=>{
 const contexts=new Set<ResourceContext>(),reserve=ResourceContext.prototype.reserveExternalMemory;
 const spy=vi.spyOn(ResourceContext.prototype,'reserveExternalMemory').mockImplementation(function(this:ResourceContext,bytes){contexts.add(this);return reserve.call(this,bytes);});
 try{
  const row=corpus.rows.find(row=>row.id==='ramp-257-8000/16000/s16le')!,run=publicRun(row,mode),result=await run.task();
  if(mode==='normal'){expect(result.exitCode).toBe(0);expect(run.commits).toBe(1);}else{expect(result.exitCode).not.toBe(0);expect(run.commits).toBe(0);expect(run.published).toEqual(run.sentinel);if(mode==='budget')expect(run.opens).toBe(0);else expect(run.aborts).toBeGreaterThan(0);}
  await new Promise<void>(resolve=>setTimeout(resolve,0));expect(contexts.size).toBeGreaterThan(0);for(const resources of contexts)expect(resources.allocatedBytes).toBe(0);
 }finally{spy.mockRestore();}
});

// Inline worker keeps this acceptance driver within its assigned owned file.
// Only the test harness reads .build; the production browser bundle receives a
// compiled Wasm module and R2 storage, with no Node compatibility flags.
const workerSource=`
import module from './edge-flac.wasm';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
export default {async fetch(request,env){
 const {args,mode='normal'}=await request.json(),controller=new AbortController(),contexts=new Set();
 const reserve=ResourceContext.prototype.reserveExternalMemory;
 ResourceContext.prototype.reserveExternalMemory=function(bytes){contexts.add(this);return reserve.call(this,bytes);};
 const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'source','/output':'output'},maxReadBytes:31,output:{writableMounts:['/output'],stagingPrefix:'stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:65536}});
 let commits=0,aborts=0,maxRead=0,maxWrite=0,unchanged=true;
 const before=await env.MEDIA_BUCKET.head('output/result');
 const filesystem={outputExists:async()=>false,async openRead(){const handle=await files.openRead('/input/input.flac');return {size:handle.size,async readAt(at,length,signal){maxRead=Math.max(maxRead,length);return handle.readAt(at,Math.min(length,7),signal);}};},async openWrite(){const handle=await files.openWrite('/output/result',{overwrite:true});return {async write(bytes){maxWrite=Math.max(maxWrite,bytes.length);if(mode==='write')throw Error('injected worker write');await handle.write(bytes);unchanged&&=(await env.MEDIA_BUCKET.head('output/result'))?.etag===before?.etag;if(mode==='cancel')controller.abort(Error('cancel worker output'));},async commit(){if(mode==='commit')throw Error('injected worker commit');await handle.commit();commits++;},async abort(reason){aborts++;await handle.abort(reason);}};}};
 try{const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module,maxReadBytes:31}}),budget:{maxResidentBytes:mode==='budget'?65536:33554432,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000},filesystem});const result=await ffmpeg.exec(args,{signal:controller.signal});await new Promise(resolve=>setTimeout(resolve,0));return Response.json({result,commits,aborts,maxRead,maxWrite,unchanged,allocated:[...contexts].map(resources=>resources.allocatedBytes),stages:(await env.MEDIA_BUCKET.list({prefix:'stage/'})).objects.length});}
 finally{ResourceContext.prototype.reserveExternalMemory=reserve;}
}};
`;

it('executes the pinned scalar resample matrix in real Workers/R2 without Node',async()=>{
 const root=resolve('tests/integration'),bundle=await build({stdin:{contents:workerSource,resolveDir:resolve('.'),sourcefile:'flac-max-resample-worker.ts',loader:'ts'},bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const path of Object.keys(bundle.metafile!.inputs)){expect(path).not.toContain('.build/');expect(path).not.toContain('runtime-node');expect(path).not.toMatch(/^node:/);}
 expect(/(?:from\s*|import\s*\()\s*['"]node:|child_process|\.build\//.test(bundle.outputFiles[0]!.text)).toBe(false);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-resample-worker.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 const failures:{id:string;error:string}[]=[];
 try{await mf.ready;const bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  const request=async(row:Row,mode='normal')=>{
   await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));
   const response=await mf.dispatchFetch('https://resample.test/',{method:'POST',body:JSON.stringify({args:row.args,mode})});expect(response.status).toBe(200);
   return await response.json() as {result:{exitCode:number;diagnostics:unknown[]};commits:number;aborts:number;maxRead:number;maxWrite:number;unchanged:boolean;allocated:number[];stages:number};
  };
  const clean=(result:Awaited<ReturnType<typeof request>>)=>{expect(result.allocated.length).toBeGreaterThan(0);expect(result.allocated.every(bytes=>bytes===0)).toBe(true);expect(result.stages).toBe(0);expect(result.maxRead).toBeLessThanOrEqual(31);expect(result.maxWrite).toBeLessThanOrEqual(65536);expect(result.unchanged).toBe(true);};
  for(const row of corpus.rows){try{
   await bucket.delete('output/result');const result=await request(row);
   if(schedulingGap(row)){expect(result.result.exitCode).not.toBe(0);expect(result.result.diagnostics).toContainEqual({code:'unsupported-command',message:'FLAC resampled framecrc/frame limits require Native packet scheduling'});expect(result.commits).toBe(0);expect(result.allocated.every(bytes=>bytes===0)).toBe(true);expect(result.stages).toBe(0);expect(await bucket.get('output/result')).toBeNull();continue;}
   clean(result);expect(result.result.diagnostics).toEqual([]);expect(result.result.exitCode).toBe(0);expect(result.commits).toBe(1);expect(result.aborts).toBe(0);
   const output=await bucket.get('output/result');expect(output).not.toBeNull();expect(hash(new Uint8Array(await output!.arrayBuffer())),row.id).toBe(row.outputSha256);
  }catch(error){failures.push({id:row.id,error:String(error)});}}
  const row=corpus.rows.find(row=>row.id==='ramp-257-8000/16000/s16le')!,sentinel=Buffer.from('worker existing output');
  for(const mode of ['write','commit','cancel','budget']){try{
   await bucket.put('output/result',sentinel);const result=await request(row,mode);clean(result);expect(result.result.exitCode).not.toBe(0);expect(result.commits).toBe(0);if(mode!=='budget')expect(result.aborts).toBeGreaterThan(0);
   expect(Buffer.from(await (await bucket.get('output/result'))!.arrayBuffer())).toEqual(sentinel);
  }catch(error){failures.push({id:mode,error:String(error)});}}
  expect(failures,'Exact scalar Native parity failures').toEqual([]);
 }finally{await mf.dispose();}
},120000);
