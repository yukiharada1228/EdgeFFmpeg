import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {expect,it} from 'vitest';

interface Row {
 id:string;scenario:string;variant:string;input:string;inputSha256:string;args:string[];exitCode:number;
 output:string|null;outputSha256:string|null;sampleCount?:number;
 canonicalSlice?:{firstSample:number;endSampleExclusive:number;exactMatch:boolean}|null;
 packets?:{pts:number;duration:number}[];
}
interface Result {
 exitCode:number;error:string|null;errorCode:string|null;published:boolean;size:number|null;sha256:string|null;emitted:string;
 range?:{startSample:string;endSampleExclusive:string|null;outputPtsSamples:string};
 unknownRange?:{startSample:string;endSampleExclusive:string|null;outputPtsSamples:string};
 pts:{pts:string;samples:number}[];reads:number;maxRead:number;shortReads:number;writes:number;maxWrite:number;
 opens:number;aborts:number;multipartLive:number;multipartCreated:number;stages:string[];
 owned:number;peak:number;reservations:number;releases:number;memoryBytes:number;cancelReasonPreserved:boolean;lateRejected:boolean;atomicChecks:number;
}
const unsupported=new Set(['ss-input','repeat-ss-t-input','t-tiny-output','ss-beyond-eof-input','repeat-to-range-input','mixed-input-output']);
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

it('executes immutable scoped FLAC time policy against pinned Native PCM/PTS on R2/workerd, including explicit unsupported cases and atomic failure cleanup',async()=>{
 const api=JSON.parse(readFileSync('tests/fixtures/hermes-max/api/time.json','utf8')) as {module:string;exports:Record<string,unknown>};
 expect(api.module).toBe('packages/avformat/src/flac-wave-time.ts');expect(api.exports).toHaveProperty('compileFlacTimePolicy');expect(api.exports).toHaveProperty('resolveFlacTimePolicy');
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-time/cases.json','utf8')) as {binarySha256:string;wasmSha256:string;rows:Row[]};
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 const rows=corpus.rows.filter(row=>row.variant==='raw');expect(rows).toHaveLength(21);expect(new Set(rows.map(row=>row.id)).size).toBe(rows.length);
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const root=resolve('tests/workers'),helper=resolve(api.module);
 // No generated source file or shared declaration edit: the actual Worker entry
 // statically binds the current production helper and external CompiledWasm.
 const bundle=await build({stdin:{contents:`import module from './edge-flac.wasm';import {createTimeFixture} from './flac-max-time-fixture.ts';import {compileFlacTimePolicy,resolveFlacTimePolicy} from ${JSON.stringify(helper)};export default createTimeFixture(module,compileFlacTimePolicy,resolveFlacTimePolicy);`,resolveDir:root,sourcefile:'flac-max-time-entry.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 expect(Object.keys(bundle.metafile!.inputs)).toContain(api.module);
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(item=>item.external&&item.path==='./edge-flac.wasm')).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-time-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 const sentinel=Buffer.from('previous-output-is-not-partial-pcm'),foreign=Buffer.from('another-transaction');
 const invoke=async(args:string[],mode='normal')=>{
  const response=await mf.dispatchFetch('https://time.test/?mode='+mode+'&args='+encodeURIComponent(JSON.stringify(args)));
  expect(response.status).toBe(200);return await response.json() as Result;
 };
 const clean=(actual:Result)=>{
  expect(actual.owned).toBe(0);expect(actual.memoryBytes).toBe(0);expect(actual.releases).toBe(actual.reservations);expect(actual.stages).toEqual([]);expect(actual.multipartLive).toBe(0);
  expect(actual.maxRead).toBeLessThanOrEqual(4096);expect(actual.maxWrite).toBeLessThanOrEqual(65536);expect(actual.peak).toBeLessThanOrEqual(33554432);
 };
 const stored=async()=>{const object=await bucket!.get('output/result.raw');return object?Buffer.from(await object.arrayBuffer()):null;};
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');await bucket.put('stage/foreign-transaction',foreign);
  for(const row of rows){
   const input=Buffer.from(row.input,'base64');expect(sha(input),row.id).toBe(row.inputSha256);await bucket.put('source/input.flac',input);await bucket.put('output/result.raw',sentinel);
   const actual=await invoke(row.args);clean(actual);
   if(unsupported.has(row.scenario)){
    // Native succeeds here, while interval-only semantics are deliberately rejected.
    expect(row.exitCode,row.id).toBe(0);expect(actual.exitCode,row.id).not.toBe(0);expect(actual.errorCode,row.id).toBe('unsupported-command');expect(actual.published).toBe(false);expect(actual.opens).toBe(0);expect(await stored()).toEqual(sentinel);continue;
   }
   if(row.exitCode!==0){
    // Do not equate the fixture's generic failure status with Native's exit 234.
    expect(actual.exitCode,row.id).not.toBe(0);expect(actual.errorCode,row.id).toBe('invalid-time');expect(actual.reads).toBe(0);expect(actual.opens).toBe(0);expect(await stored()).toEqual(sentinel);continue;
   }
   const expected=Buffer.from(row.output!,'base64');expect(sha(expected)).toBe(row.outputSha256);
   expect(actual.exitCode,row.id+': '+actual.error).toBe(0);expect(actual.published).toBe(true);expect(actual.atomicChecks).toBeGreaterThan(0);expect(await stored(),row.id).toEqual(expected);
   expect(actual.sha256,row.id).toBe(row.outputSha256);expect(actual.size,row.id).toBe(expected.length);expect(actual.emitted,row.id).toBe(String(row.sampleCount));
   expect(actual.range?.outputPtsSamples).toBe('0');expect(actual.reservations).toBe(1);expect(actual.peak).toBeGreaterThanOrEqual(16777216);expect(actual.reads).toBeGreaterThan(0);expect(actual.shortReads).toBeGreaterThan(0);expect(actual.opens).toBe(1);expect(actual.multipartCreated).toBe(1);
   const clock=corpus.rows.find(item=>item.scenario===row.scenario&&item.variant==='framecrc');expect(clock?.exitCode).toBe(0);
   expect(actual.pts,row.id).toEqual(clock!.packets!.map(packet=>({pts:String(packet.pts),samples:packet.duration})));
   if(row.canonicalSlice){expect(actual.range?.startSample).toBe(String(row.canonicalSlice.firstSample));expect(actual.range?.endSampleExclusive).toBe(String(row.canonicalSlice.endSampleExclusive));}
  }
  const baseline=rows.find(row=>row.scenario==='baseline')!;await bucket.put('source/input.flac',Buffer.from(baseline.input,'base64'));
  for(const mode of ['cancel-write','write-failure','output-budget','read-abort','late-read-abort']){
   await bucket.put('output/result.raw',sentinel);const actual=await invoke(baseline.args,mode);clean(actual);
   expect(actual.exitCode,mode).not.toBe(0);expect(actual.published,mode).toBe(false);expect(await stored(),mode).toEqual(sentinel);expect(actual.sha256).toBe(sha(sentinel));
   if(mode.includes('read-abort')){expect(actual.opens).toBe(0);expect(actual.cancelReasonPreserved,mode).toBe(true);}else expect(actual.aborts).toBe(1);
   if(mode==='cancel-write')expect(actual.cancelReasonPreserved).toBe(true);if(mode==='late-read-abort')expect(actual.lateRejected).toBe(true);
  }
  // Unknown STREAMINFO length uses null, not an invented empty source. This is
  // a storage/decoder control, not an additional Native compatibility claim.
  const unknown=Buffer.from(baseline.input,'base64');unknown[21]=unknown[21]!&0xf0;unknown.fill(0,22,26);await bucket.put('source/input.flac',unknown);
  const actual=await invoke(baseline.args);clean(actual);expect(actual.exitCode,actual.error??'').toBe(0);expect(actual.range?.endSampleExclusive).toBe(null);expect(actual.unknownRange?.endSampleExclusive).toBe(null);expect(actual.emitted).toBe(String(baseline.sampleCount));expect(await stored()).toEqual(Buffer.from(baseline.output!,'base64'));
  expect(Buffer.from(await (await bucket.get('stage/foreign-transaction'))!.arrayBuffer())).toEqual(foreign);
  expect((await bucket.list()).objects.map(item=>item.key).sort()).toEqual(['output/result.raw','source/input.flac','stage/foreign-transaction']);
 }finally{
  if(bucket){await bucket.delete(['source/input.flac','output/result.raw','stage/foreign-transaction']);expect((await bucket.list()).objects).toEqual([]);}
  await mf.dispose();
 }
},60000);

it('matches Native raw/WAV time cases through public FFmpeg on R2/workerd and preserves committed output on failures',async()=>{
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-time/cases.json','utf8')) as {binarySha256:string;wasmSha256:string;rows:Row[]};
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 const rows=corpus.rows.filter(row=>row.variant==='raw'||row.variant==='wav');expect(rows).toHaveLength(42);
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const root=resolve('tests/workers');
 const bundle=await build({entryPoints:[root+'/flac-backend-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(item=>item.external&&item.path==='./edge-flac.wasm')).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-time-public-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 interface PublicResult {exitCode:number;outputs:string[];sha256:string|null;size:number|null;opens:number;reads:number;maxRead:number;maxWrite:number;stages:number;multipartLive:number;diagnostics:{code:string;message:string}[]}
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 const failures:{id:string;error:string}[]=[],sentinel=Buffer.from('previous-public-time-output'),foreign=Buffer.from('unrelated-time-transaction');
 const invoke=async(row:Row,mode='normal')=>{
  const args=['-y',...row.args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg)];
  const response=await mf.dispatchFetch('https://time-public.test/?mode='+mode+'&args='+encodeURIComponent(JSON.stringify(args)));
  expect(response.status).toBe(200);return await response.json() as PublicResult;
 };
 const stored=async()=>{const object=await bucket!.get('output/result.raw');return object?Buffer.from(await object.arrayBuffer()):null;};
 const clean=(actual:PublicResult)=>{expect(actual.stages).toBe(0);expect(actual.multipartLive).toBe(0);expect(actual.maxRead).toBeLessThanOrEqual(4096);expect(actual.maxWrite).toBeLessThanOrEqual(65536);};
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');await bucket.put('foreign/time-transaction',foreign);
  for(const row of rows){
   try{
    const input=Buffer.from(row.input,'base64');expect(sha(input)).toBe(row.inputSha256);await bucket.put('source/input.flac',input);await bucket.put('output/result.raw',sentinel);
    const actual=await invoke(row);clean(actual);
    if(unsupported.has(row.scenario)||row.exitCode!==0){
     expect(actual.exitCode,JSON.stringify(actual.diagnostics)).not.toBe(0);expect(actual.outputs).toEqual([]);expect(actual.opens).toBe(0);expect(await stored()).toEqual(sentinel);expect(actual.sha256).toBe(sha(sentinel));
     expect(actual.diagnostics[0]?.code).toBe(unsupported.has(row.scenario)?'unsupported-command':'invalid-time');
     if(unsupported.has(row.scenario))expect(row.exitCode).toBe(0);
    }else{
     const expected=Buffer.from(row.output!,'base64');expect(sha(expected)).toBe(row.outputSha256);
     expect(actual.exitCode,JSON.stringify(actual.diagnostics)).toBe(0);expect(actual.outputs).toEqual(['/output/result.raw']);expect(actual.opens).toBe(1);expect(actual.reads).toBeGreaterThan(0);
     expect(actual.sha256).toBe(row.outputSha256);expect(actual.size).toBe(expected.length);expect(await stored()).toEqual(expected);
    }
   }catch(error){failures.push({id:row.id,error:String(error)});}
  }
  // WAV has a header and PCM write, so the shared public fixture's second-write
  // failure is exercised rather than silently succeeding on single-write raw PCM.
  const baseline=rows.find(row=>row.scenario==='baseline'&&row.variant==='wav')!;
  await bucket.put('source/input.flac',Buffer.from(baseline.input,'base64'));
  for(const mode of ['cancel-write','write-failure','output-budget']){
   try{
    await bucket.put('output/result.raw',sentinel);const actual=await invoke(baseline,mode);clean(actual);
    expect(actual.exitCode,mode).not.toBe(0);expect(actual.outputs).toEqual([]);expect(actual.sha256).toBe(sha(sentinel));expect(await stored()).toEqual(sentinel);
   }catch(error){failures.push({id:mode,error:String(error)});}
  }
  expect(Buffer.from(await (await bucket.get('foreign/time-transaction'))!.arrayBuffer())).toEqual(foreign);
  expect((await bucket.list()).objects.map(item=>item.key).sort()).toEqual(['foreign/time-transaction','output/result.raw','source/input.flac']);
  expect(failures,JSON.stringify(failures)).toEqual([]);
 }finally{
  if(bucket){await bucket.delete(['source/input.flac','output/result.raw','foreign/time-transaction']);expect((await bucket.list()).objects).toEqual([]);}
  await mf.dispose();
 }
},60000);
