import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {countResampledFlacSamples} from '../../packages/avformat/src/flac-wave-resample.js';

interface Row {
 id:string;args:string[];input:string;inputSha256:string;output:string|null;outputSha256:string|null;exitCode:number;stderr:string;
 variant:string;outputSampleRate:number;sampleCount?:number;descriptors:{sampleRate:number;totalSamples:number;channels:number}[];
}
interface Result {
 error:string|null;cancelReasonPreserved:boolean;committed:boolean;sha256:string;storedSha256:string|null;storedSize:number|null;totalBytes:number;sampleCount:number;
 frames:{samples:number;pts:string|null;num:string|null;den:string|null;rate:number;format:string;bytes:number;owned:number}[];
 owned:number;peak:number;reservations:number;releases:number;reads:number;maxRead:number;maxReturned:number;shortReads:number;writes:number;maxWrite:number;
 sourceFrames:number;sourceReleased:number;sourceReturns:number;memoryBytes:number;lateSettled:boolean;multipartLive:number;multipartCreated:number;multipartAborted:number;stages:number;
}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const pinned='1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';

it('resamples scalar-profile real FLAC through the helper in workerd/local R2 with exact finite drain, byte hashes and transactional cleanup',async()=>{
 // Missing oracle/helper is a hard failure, never an optional test skip.
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-resample/scalar.json','utf8')) as {binarySha256:string;wasmSha256:string;referenceOptions:string[];rows:Row[]};
 expect(corpus.binarySha256).toBe(pinned);expect(corpus.referenceOptions).toEqual(['-cpuflags','0']);expect(corpus.rows).toHaveLength(60);
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const raw=corpus.rows.filter(row=>row.variant==='s16le');expect(raw).toHaveLength(20);
 const successes=raw.filter(row=>row.exitCode===0);expect(successes.length).toBeGreaterThan(0);
 for(const row of raw){
  expect(row.args.slice(0,2),row.id).toEqual(['-cpuflags','0']);
  expect(sha(Buffer.from(row.input,'base64')),row.id).toBe(row.inputSha256);
  if(row.exitCode!==0){expect(row.stderr,row.id).not.toBe('');continue;}
  expect(row.output,row.id).not.toBeNull();expect(sha(Buffer.from(row.output!,'base64')),row.id).toBe(row.outputSha256);
  expect(countResampledFlacSamples(BigInt(row.descriptors[0]!.totalSamples),row.descriptors[0]!.sampleRate,row.outputSampleRate),row.id).toBe(BigInt(row.sampleCount!));
 }
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-max-resample-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-resample-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 const request=async(row:Row,options:Record<string,unknown>={})=>{
  const response=await mf.dispatchFetch('https://resample.test/',{method:'POST',body:JSON.stringify({outputRate:row.outputSampleRate,targetFormat:'s16',...options})});
  return {status:response.status,result:await response.json() as Result};
 };
 const cleaned=(result:Result)=>{
  expect(result.owned).toBe(0);expect(result.memoryBytes).toBe(0);expect(result.reservations).toBe(result.releases);
  expect(result.sourceFrames).toBe(result.sourceReleased);expect(result.multipartLive).toBe(0);expect(result.stages).toBe(0);
  expect(result.peak).toBeLessThanOrEqual(33554432);expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxReturned).toBeLessThanOrEqual(19);expect(result.maxWrite).toBeLessThanOrEqual(1024);
 };
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const row of successes){
   await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));await bucket.delete('output/result.raw');
   const {status,result}=await request(row);expect(status,row.id+': '+result.error).toBe(200);expect(result.error,row.id).toBeNull();expect(result.committed).toBe(true);
   expect.soft(result.sampleCount,row.id).toBe(row.sampleCount);expect.soft(result.sha256,row.id).toBe(row.outputSha256);expect.soft(result.storedSha256,row.id).toBe(row.outputSha256);expect.soft(result.storedSize,row.id).toBe(Buffer.from(row.output!,'base64').length);
   // Read the exact published target back, independently of fixture digest reporting.
   expect.soft(Buffer.from(await (await bucket.get('output/result.raw'))!.arrayBuffer()).equals(Buffer.from(row.output!,'base64')),row.id).toBe(true);
   let position=0n;
   for(const frame of result.frames){expect(frame.pts,row.id).toBe(String(position));expect(frame.num).toBe('1');expect(frame.den).toBe(String(row.outputSampleRate));expect(frame.rate).toBe(row.outputSampleRate);expect(frame.format).toBe('s16');expect(frame.bytes).toBeLessThanOrEqual(1024);expect(frame.owned).toBeGreaterThanOrEqual(frame.bytes);position+=BigInt(frame.samples);}
   expect(position).toBe(BigInt(row.sampleCount!));expect(result.reads).toBeGreaterThan(0);expect(result.shortReads).toBeGreaterThan(0);cleaned(result);
  }
  const row=successes.find(row=>(row.sampleCount??0)>512&&row.descriptors[0]!.sampleRate!==row.outputSampleRate);expect(row).toBeDefined();
  await bucket.put('source/input.flac',Buffer.from(row!.input,'base64'));
  // Physical source partitions cannot alter filter history, sample count or output.
  for(const chunkSamples of [1,128]){const {status,result}=await request(row!,{chunkSamples});expect(status,result.error??'').toBe(200);expect.soft(result.storedSha256).toBe(row!.outputSha256);expect(result.sampleCount).toBe(row!.sampleCount);cleaned(result);}
  const sentinel=Buffer.from('existing-resample-output');
  for(const mode of ['cancel-write','write-failure','early-return','held-abort','pending-reject','pending-resolve','return-reject','frame-budget','output-budget']){
   await bucket.put('output/result.raw',sentinel);const {status,result}=await request(row!,{mode});
   expect(status,mode+': '+result.error).toBe(mode==='early-return'?200:422);expect(result.committed,mode).toBe(false);expect(result.storedSha256,mode).toBe(sha(sentinel));expect(result.storedSize).toBe(sentinel.length);
   expect(Buffer.from(await (await bucket.get('output/result.raw'))!.arrayBuffer()).equals(sentinel),mode).toBe(true);
   if(['cancel-write','held-abort','pending-reject','pending-resolve'].includes(mode))expect(result.cancelReasonPreserved,mode).toBe(true);
   if(mode.startsWith('pending-'))expect(result.lateSettled).toBe(true);cleaned(result);
  }
 }finally{
  if(bucket){const stages=(await bucket.list({prefix:'resample-stage/'})).objects;for(const object of stages)await bucket.delete(object.key);await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');expect(stages).toEqual([]);expect((await bucket.list()).objects).toEqual([]);}
  await mf.dispose();
 }
},120000);
