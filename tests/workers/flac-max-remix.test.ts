import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import arithmeticProfile from '../../compat/behavior-specs/flac-max-remix/arithmetic.json' with {type:'json'};

interface NativePacket {pts:number;dts:number;duration:number;bytes:number;checksum:string}
interface Row {id:string;input:string;inputSha256:string;output:string|null;outputSha256:string|null;exitCode:number;stderr:string;format:string;rawPartner?:string;sampleCount?:number;descriptors:{totalSamples:number;channels:number;bitsPerSample:number}[];outputDescriptor:{channels:1|2;codec:string};packets?:NativePacket[]}
interface Corpus {binarySha256:string;wasmSha256:string;coverage:{complete:boolean;plannedFullRows:number};rows:Row[]}
interface Result {ok:boolean;error:string|null;size:number|null;sha256:string|null;samples:number;packets:{pts:string|null;duration:string;bytes:number;checksum:string}[];timestamps:{pts:string|null;samples:number;layout:string;reserved:number}[];reads:number;maxRead:number;maxReturnedRead:number;writes:number;maxWrite:number;aborts:number;multipartLive:number;multipartCreated:number;returned:number;produced:number;allocated:number;peak:number;heldReservation:number;prepublicationUnchanged:boolean;stages:number}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

it('remixes pinned Native FLAC PCM through real workerd/R2 with bounded reservations, timestamps and transactional cleanup',async()=>{
 const api=JSON.parse(readFileSync('tests/fixtures/hermes-max/api/remix.json','utf8')) as {module:string;exports:string[]};expect(api.module).toBe('packages/avformat/src/flac-wave-remix.ts');expect(api.exports).toContain('remixFlacAudio');
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-remix/cases.json','utf8')) as Corpus;
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-max-remix-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);expect(name).not.toContain('runtime-node');}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-remix-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 expect(arithmeticProfile.binarySha256).toBe(corpus.binarySha256);
 const request=async(row:Row,extra:Record<string,string>={})=>{const params=new URLSearchParams({codec:row.outputDescriptor.codec,channels:String(row.outputDescriptor.channels),arithmetic:arithmeticProfile.default.arithmetic,...extra});const response=await mf.dispatchFetch('https://flac-max-remix.test/?'+params);expect(response.status).toBe(200);return await response.json() as Result;};
 const clean=(result:Result)=>{expect(result.allocated).toBe(0);expect(result.multipartLive).toBe(0);expect(result.stages).toBe(0);expect(result.prepublicationUnchanged).toBe(true);expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxReturnedRead).toBeLessThanOrEqual(37);expect(result.maxWrite).toBeLessThanOrEqual(65536);expect(result.peak).toBeLessThanOrEqual(33554432);};
 const failures:unknown[]=[],nativeFailures=corpus.rows.filter(row=>row.exitCode!==0).map(row=>({id:row.id,exitCode:row.exitCode,stderr:row.stderr}));
 try{await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const row of corpus.rows){if(row.exitCode!==0)continue;try{
   const raw=row.format==='framecrc'?corpus.rows.find(candidate=>candidate.id===row.rawPartner)!:row;expect(raw.exitCode).toBe(0);expect(raw.output).not.toBeNull();
   const input=Buffer.from(row.input,'base64'),expected=Buffer.from(raw.output!,'base64');expect(sha(input)).toBe(row.inputSha256);expect(sha(expected)).toBe(raw.outputSha256);await bucket.put('source/input.flac',input);await bucket.delete('output/result.raw');
   const result=await request(row);expect(result.ok,row.id+': '+result.error).toBe(true);expect(result.sha256,row.id).toBe(raw.outputSha256);expect(result.size,row.id).toBe(expected.length);expect(result.samples,row.id).toBe(row.descriptors[0]!.totalSamples);expect(Buffer.from(await (await bucket.get('output/result.raw'))!.arrayBuffer()),row.id).toEqual(expected);
   let position=0;for(const stamp of result.timestamps){expect(stamp.pts).toBe(String(position));expect(stamp.layout).toBe(row.outputDescriptor.channels===1?'mono':'stereo');expect(stamp.reserved).toBeGreaterThan(16777216);position+=stamp.samples;}expect(position).toBe(result.samples);expect(result.returned).toBe(1);expect(result.produced).toBe(result.timestamps.length);expect(result.reads).toBeGreaterThan(1);expect(result.multipartCreated).toBe(1);clean(result);
   if(row.format==='framecrc')expect(result.packets).toEqual(row.packets!.map(packet=>({pts:String(packet.pts),duration:String(packet.duration),bytes:packet.bytes,checksum:packet.checksum})));
   else{await bucket.delete('output/result.raw');const fragmented=await request(row,{chunk:'17'});expect(fragmented.ok,row.id+': '+fragmented.error).toBe(true);expect(fragmented.sha256,row.id).toBe(raw.outputSha256);expect(fragmented.size).toBe(expected.length);expect(fragmented.samples).toBe(row.descriptors[0]!.totalSamples);expect(Buffer.from(await (await bucket.get('output/result.raw'))!.arrayBuffer())).toEqual(expected);let position=0;for(const stamp of fragmented.timestamps){expect(stamp.pts).toBe(String(position));expect(stamp.samples).toBeLessThanOrEqual(17);position+=stamp.samples;}expect(position).toBe(fragmented.samples);expect(fragmented.produced).toBe(fragmented.timestamps.length);expect(fragmented.returned).toBe(1);clean(fragmented);}
  }catch(error){failures.push({id:row.id,error:String(error)});}}
  const row=corpus.rows.find(row=>row.id.includes('32-2-extremes')&&row.format==='s32le'&&row.exitCode===0)??corpus.rows.find(row=>row.format==='s32le'&&row.exitCode===0);expect(row).toBeDefined();
  if(row){await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));const sentinel=Buffer.from('previous-remix-output');
   for(const mode of ['cancel-write','write-failure','cancel-read-late','output-budget','frame-budget','resident-budget','early-close','invalid-layout']){try{await bucket.put('output/result.raw',sentinel);const result=await request(row,{mode,chunk:'17'});expect(result.ok,mode).toBe(false);expect(result.error,mode).not.toBeNull();expect(result.sha256,mode).toBe(sha(sentinel));expect(result.size).toBe(sentinel.length);expect(Buffer.from(await (await bucket.get('output/result.raw'))!.arrayBuffer())).toEqual(sentinel);clean(result);if(!['resident-budget','cancel-read-late'].includes(mode)){expect(result.aborts,mode).toBeGreaterThan(0);expect(result.returned,mode).toBe(1);}if(mode==='write-failure')expect(result.writes).toBe(2);}catch(error){failures.push({mode,error:String(error)});}}
   for(const layout of ['','unknown','unspecified','count']){try{await bucket.delete('output/result.raw');const result=await request(row,{layout,chunk:'17',origin:'9007199254740993'});expect(result.ok,result.error??layout).toBe(true);expect(result.sha256).toBe(row.outputSha256);let position=9007199254740993n;for(const stamp of result.timestamps){expect(stamp.pts).toBe(position.toString());position+=BigInt(stamp.samples);}expect(position).toBe(9007199254740993n+BigInt(row.descriptors[0]!.totalSamples));clean(result);}catch(error){failures.push({layout,error:String(error)});}}
  }
  // Reference failures are evidence gaps, never reclassified as supported outputs.
  expect(nativeFailures,'Native failures require a scoped compatibility decision: '+JSON.stringify(nativeFailures)).toEqual([]);
  expect(failures).toEqual([]);
 }finally{if(bucket){const stages=(await bucket.list({prefix:'stage/'})).objects;await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');expect(stages).toEqual([]);expect((await bucket.list()).objects).toEqual([]);}await mf.dispose();}
},120000);

it('requires complete bidirectional 16/24/32-bit Native evidence separately from available-row Workers parity',()=>{
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-remix/cases.json','utf8')) as Corpus;
 expect.soft(corpus.coverage.complete,'Available-row parity does not establish full remix acceptance').toBe(true);
 expect.soft(corpus.coverage.plannedFullRows).toBe(60);
 expect.soft(corpus.rows,'Full bidirectional 16/24/32-bit Native corpus is required for acceptance').toHaveLength(60);
 expect.soft([...new Set(corpus.rows.map(row=>row.descriptors[0]!.bitsPerSample))].sort((a,b)=>a-b)).toEqual([16,24,32]);
 expect.soft([...new Set(corpus.rows.map(row=>`${row.descriptors[0]!.channels}->${row.outputDescriptor.channels}`))].sort()).toEqual(['1->2','2->1']);
});
