import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
interface Row {id:string;input:string;inputSha256:string;bits:number;channels:number;samples:number;pcmSha256:string;frames:{samples:number;samplePosition:string}[]}
interface Result {metadata?:{channels:number;sampleRate:number;bitsPerSample:number;totalSamples:string};pcmSha256?:string;frames?:Row['frames'];totalBytes?:number;owned:number;peak:number;reads:number;maxRead:number;reservations:number;releases:number;memoryBytes:number;closedEarly?:boolean;error?:string;cancelReasonPreserved?:boolean}
it('matches 78 clean Native PCM cases through the public FLAC Wasm decoder on R2/workerd with reservation and cancellation controls',async()=>{
 const base=new URL('../../compat/behavior-specs/flac-decode-workers/',import.meta.url),raw=readFileSync(new URL('cases.json',base)),manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8')) as {casesSha256:string},hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');expect(hash(raw)).toBe(manifest.casesSha256);
 const corpus=JSON.parse(raw.toString()) as {wasmSha256:string;rows:Row[]};expect(corpus.rows).toHaveLength(78);const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(hash(wasm)).toBe(corpus.wasmSha256);
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-decode-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-decode-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;const failures:unknown[]=[];
 try{await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const row of corpus.rows){try{const input=Buffer.from(row.input,'base64');expect(hash(input)).toBe(row.inputSha256);await bucket.put('source/input.flac',input);const response=await mf.dispatchFetch('https://decode.test/');expect(response.status,row.id).toBe(200);const actual=await response.json() as Result;
   expect(actual.metadata,row.id).toMatchObject({channels:row.channels,sampleRate:8000,bitsPerSample:row.bits,totalSamples:String(row.samples)});expect(actual.pcmSha256,row.id).toBe(row.pcmSha256);expect(actual.frames,row.id).toEqual(row.frames);expect(actual.totalBytes).toBe(row.samples*row.channels*(row.bits<=16?2:4));expect(actual.owned).toBe(0);expect(actual.memoryBytes).toBe(0);expect(actual.reservations).toBe(1);expect(actual.releases).toBe(1);expect(actual.peak).toBeGreaterThanOrEqual(16777216);expect(actual.peak).toBeLessThanOrEqual(16842752);expect(actual.maxRead).toBeLessThanOrEqual(4096);expect(actual.reads).toBeGreaterThan(0);
  }catch(error){failures.push({id:row.id,error:String(error)});}}
  const control=corpus.rows.find(row=>row.samples>0)!;await bucket.put('source/input.flac',Buffer.from(control.input,'base64'));
  for(const mode of ['read-abort','held-abort','checkpoint-abort','reservation-budget','frame-budget','close-held']){try{const response=await mf.dispatchFetch('https://decode.test/?mode='+mode);expect(response.status,mode).toBe(mode==='close-held'?200:422);const actual=await response.json() as Result;expect(actual.owned).toBe(0);expect(actual.memoryBytes).toBe(0);expect(actual.peak).toBeLessThanOrEqual(16842752);expect(actual.reservations).toBe(mode==='reservation-budget'?0:1);expect(actual.releases).toBe(mode==='reservation-budget'?0:1);if(mode.endsWith('abort'))expect(actual.cancelReasonPreserved,mode).toBe(true);if(mode==='reservation-budget')expect(actual.reads).toBe(0);if(mode==='close-held')expect(actual.closedEarly).toBe(true);}catch(error){failures.push({mode,error:String(error)});}}
  expect(failures).toEqual([]);
 }finally{if(bucket){await bucket.delete('source/input.flac');expect((await bucket.list()).objects).toEqual([]);}await mf.dispose();}
},60000);
