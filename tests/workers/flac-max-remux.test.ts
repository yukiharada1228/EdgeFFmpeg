import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

interface Packet {pts:number|null;dts:number|null;duration:number|null;bytes:number;dataSha256:string}
interface NativeRow {id:string;input:string;inputSha256:string;args:string[];exitCode:number;output:string|null;outputSha256:string|null;outputProbe:{packets:Packet[]}|null}
interface Result {exitCode:number;outputs:string[];diagnostics:{code:string;message:string}[];cancelled:boolean;size:number|null;sha256:string|null;reads:number;maxRead:number;maxReturned:number;writes:number;maxWrite:number;opens:number;aborts:number;maxActiveWrites:number;atomic:boolean;multipartLive:number;multipartCreated:number;multipartParts:number;stages:number}
interface Inspection {extradata:string;tags:unknown;packets:{sha256:string;size:number;pts:string|null;dts:string|null;duration:string|null}[];frames:{samples:number;samplePosition:string}[];pcmSha256:string|null;samples:string;owned:number;peak:number;maxRead:number;maxReturned:number}
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-remux/cases.json','utf8')) as {binarySha256:string;wasmSha256:string;rows:NativeRow[]};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
let mf:Miniflare,bucket:Awaited<ReturnType<Miniflare['getR2Bucket']>>;
const argv=(row:NativeRow)=>row.args.filter((arg,index,args)=>arg!=='-blocksize'&&args[index-1]!=='-blocksize').map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.flac':arg);
const run=async(args:string[],parameters:Record<string,string>={})=>{
 const query=new URLSearchParams({args:JSON.stringify(args),...parameters});
 const response=await mf.dispatchFetch('https://remux.test/?'+query);
 expect(response.status,await response.clone().text()).toBe(200);
 return await response.json() as Result;
};
const inspect=async(path:string,decode=false)=>{
 const response=await mf.dispatchFetch('https://remux.test/?'+new URLSearchParams({action:'inspect',path,decode:decode?'1':'0'}));
 expect(response.status,await response.clone().text()).toBe(200);
 const actual=await response.json() as Inspection;
 expect(actual.owned).toBe(0);expect(actual.peak).toBeLessThanOrEqual(17825792);expect(actual.maxRead).toBeLessThanOrEqual(4096);expect(actual.maxReturned).toBeLessThanOrEqual(1021);
 return actual;
};
const clean=(actual:Result,shortRead=1021)=>{
 expect(actual.stages).toBe(0);expect(actual.multipartLive).toBe(0);expect(actual.atomic).toBe(true);
 expect(actual.maxRead).toBeLessThanOrEqual(65536);expect(actual.maxReturned).toBeLessThanOrEqual(shortRead);expect(actual.maxWrite).toBeLessThanOrEqual(65536);expect(actual.maxActiveWrites).toBeLessThanOrEqual(1);
};
beforeAll(async()=>{
 const api=JSON.parse(readFileSync('tests/fixtures/hermes-max/api/remux.json','utf8')) as {exports:Record<string,string[]>};
 expect(api.exports['packages/avformat/src/flac-wave-remux.ts']?.some(value=>value.startsWith('executeFlacRemux('))).toBe(true);
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');expect(corpus.rows).toHaveLength(28);
 const root=resolve('tests/workers'),wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const bundle=await build({entryPoints:[root+'/flac-max-remux-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('node:')).toBe(false);expect(name.startsWith('.build/')).toBe(false);}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-remux-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
},30000);
afterAll(async()=>{
 try{if(bucket){for(const key of ['source/input.flac','source/native.flac','output/result.flac'])await bucket.delete(key);expect((await bucket.list()).objects).toEqual([]);}}
 finally{await mf?.dispose();}
});

it('matches all 26 Native-positive FLAC remux rows through both public dispatch and the current helper in Workers/R2',async()=>{
 const failures:unknown[]=[];let positive=0;
 for(const row of corpus.rows.filter(row=>row.exitCode===0&&row.id!=='overwrite-n')){
  try{
   const input=Buffer.from(row.input,'base64'),native=Buffer.from(row.output!,'base64');expect(sha(input)).toBe(row.inputSha256);expect(sha(native)).toBe(row.outputSha256);
   await bucket.put('source/input.flac',input);await bucket.put('source/native.flac',native);
   const shortRead=row.id.startsWith('short-read-')?Number(row.id.slice('short-read-'.length)):1021;
   for(const route of ['public','helper']){
    if(row.id==='overwrite-y')await bucket.put('output/result.flac','old committed output');else await bucket.delete('output/result.flac');
    // Native file-protocol -blocksize is exercised as VFS short reads, not falsely claimed as CLI support.
    const actual=await run(argv(row),{route,shortRead:String(shortRead)});
    expect(actual.exitCode,JSON.stringify(actual.diagnostics)).toBe(0);expect(actual.outputs).toEqual(['/output/result.flac']);expect(actual.sha256).toBe(row.outputSha256);expect(actual.size).toBe(native.length);expect(actual.opens).toBe(1);expect(actual.multipartCreated).toBeGreaterThan(0);clean(actual,shortRead);
    const published=await bucket.get('output/result.flac');expect(Buffer.from(await published!.arrayBuffer())).toEqual(native);
   }
   const actual=await inspect('/output/result.flac'),expected=await inspect('/input/native.flac');
   expect(actual.extradata).toBe(input.subarray(8,42).toString('hex'));expect(actual.extradata).toBe(expected.extradata);expect(actual.tags).toEqual(expected.tags);expect(actual.packets).toEqual(expected.packets);
   expect(actual.packets).toEqual(row.outputProbe!.packets.map(packet=>({sha256:packet.dataSha256,size:packet.bytes,pts:packet.pts===null?null:String(packet.pts),dts:packet.dts===null?null:String(packet.dts),duration:packet.duration===null?null:String(packet.duration)})));
   positive++;
  }catch(error){failures.push({id:row.id,error:String(error)});}
 }
 expect(failures,JSON.stringify(failures)).toEqual([]);expect(positive).toBe(26);
},180000);

it('preserves independently decoded Native PCM for 16/24/32-bit remux outputs on real Wasm',async()=>{
 for(const id of ['16-2-ramp-5/default','24-2-ramp-5/default','32-2-ramp-5/default']){
  const row=corpus.rows.find(row=>row.id===id)!;await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));await bucket.put('source/native.flac',Buffer.from(row.output!,'base64'));await bucket.delete('output/result.flac');
  const result=await run(argv(row));expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);clean(result);
  const actual=await inspect('/output/result.flac',true),expected=await inspect('/input/native.flac',true),input=await inspect('/input/input.flac',true);
  expect(actual.pcmSha256).toBe(expected.pcmSha256);expect(actual.pcmSha256).toBe(input.pcmSha256);expect(actual.samples).toBe(expected.samples);expect(actual.samples).not.toBe('0');expect(actual.frames).toEqual(expected.frames);
 }
},60000);

it('preserves committed output and cleans R2 stages on cancellation, late rejection and provider/budget failures',async()=>{
 const row=corpus.rows.find(row=>row.id==='16-2-ramp-5/default')!,sentinel=Buffer.from('previous committed remux output');
 await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));
 for(const route of ['public','helper'])for(const mode of ['read-abort','cancel-write','write-failure','late-write-failure','output-budget','part-failure']){
  await bucket.put('output/result.flac',sentinel);const actual=await run(argv(row),{route,mode});
  expect(actual.exitCode,route+'/'+mode).not.toBe(0);expect(actual.outputs).toEqual([]);expect(actual.sha256).toBe(sha(sentinel));expect(actual.size).toBe(sentinel.length);clean(actual);
  if(mode==='read-abort')expect(actual.opens).toBe(0);else expect(actual.aborts).toBeGreaterThan(0);
  if(['read-abort','cancel-write','late-write-failure'].includes(mode))expect(actual.cancelled).toBe(true);
  if(mode==='part-failure')expect(actual.multipartParts).toBeGreaterThan(0);
 }
},60000);

it('matches Native overwrite refusal and reports unsupported duplicate maps and CLI blocksize explicitly',async()=>{
 const row=corpus.rows.find(row=>row.id==='overwrite-n')!;
 const sentinel=Buffer.from(row.output!,'base64');expect(sha(sentinel)).toBe(row.outputSha256);await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));
 for(const route of ['public','helper']){
  await bucket.put('output/result.flac',sentinel);const denied=await run(argv(row),{route});
  // Native AVERROR_EXIT maps to exit 0 while retaining the old file; Core matches it.
  expect(row.exitCode).toBe(0);expect(denied.exitCode).toBe(row.exitCode);expect(denied.outputs).toEqual([]);expect(denied.sha256).toBe(row.outputSha256);expect(denied.opens).toBe(0);clean(denied);
  const duplicate=corpus.rows.find(row=>row.id==='duplicate-audio')!;expect(duplicate.exitCode).not.toBe(0);
  const rejected=await run(argv(duplicate),{route});expect(rejected.exitCode).not.toBe(0);expect(rejected.diagnostics[0]?.code).toBe('unsupported-command');expect(rejected.opens).toBe(0);expect(rejected.sha256).toBe(row.outputSha256);clean(rejected);
  const blocksize=await run(['-y','-blocksize','1','-i','/input/input.flac','-c:a','copy','-f','flac','/output/result.flac'],{route});
  expect(blocksize.exitCode).not.toBe(0);expect(blocksize.diagnostics[0]?.code).toBe('invalid-arguments');expect(blocksize.opens).toBe(0);expect(blocksize.sha256).toBe(row.outputSha256);clean(blocksize);
 }
},30000);
