import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
interface Row {id:string;input:string;inputSha256:string;args:string[];output:string;outputSha256:string;exitCode:number}
interface Result {exitCode:number;outputs:string[];size:number|null;sha256:string|null;reads:number;maxRead:number;writes:number;maxWrite:number;opens:number;aborts:number;stages:number;multipartLive:number;diagnostics:{code:string;message:string}[]}
it('matches 342 finite Native FLAC decoded outputs through the public backend on actual R2/workerd with transactional failures',async()=>{
 const source=readFileSync('compat/behavior-specs/flac-decode-cli/cases.json'),corpus=JSON.parse(source.toString()) as {wasmSha256:string;rows:Row[]};expect(corpus.rows).toHaveLength(342);
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-backend-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-backend-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;const failures:unknown[]=[];
 const argv=(row:Row)=>row.args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg);
 const request=(args:string[],mode='normal')=>mf.dispatchFetch('https://flac-backend.test/?mode='+mode+'&args='+encodeURIComponent(JSON.stringify(args)));
 try{await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');let previous='';
  for(const row of corpus.rows){try{if(row.inputSha256!==previous){const input=Buffer.from(row.input,'base64');expect(sha(input)).toBe(row.inputSha256);await bucket.put('source/input.flac',input);previous=row.inputSha256;}await bucket.delete('output/result.raw');const response=await request(argv(row));expect(response.status).toBe(200);const result=await response.json() as Result;
   expect(result.exitCode,row.id+JSON.stringify(result.diagnostics)).toBe(row.exitCode);expect(result.sha256,row.id).toBe(row.outputSha256);expect(result.size,row.id).toBe(Buffer.from(row.output,'base64').length);expect(result.outputs).toEqual(['/output/result.raw']);expect(result.opens).toBe(1);expect(result.reads).toBeGreaterThan(0);expect(result.maxRead).toBeLessThanOrEqual(65536);expect(result.maxWrite).toBeLessThanOrEqual(65536);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);
  }catch(error){failures.push({id:row.id,error:String(error)});}}
  const row=corpus.rows.find(row=>row.id==='32-2-extremes-5/wav')!;await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));
  const sentinel=Buffer.from('previous-output');for(const mode of ['cancel-write','write-failure','output-budget','missing-module']){try{await bucket.put('output/result.raw',sentinel);const response=await request(['-y',...argv(row)],mode);expect(response.status).toBe(200);const result=await response.json() as Result;expect(result.exitCode,mode).not.toBe(0);expect(result.sha256,mode).toBe(sha(sentinel));expect(result.size).toBe(sentinel.length);expect(result.outputs).toEqual([]);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);if(mode==='missing-module')expect(result.opens).toBe(0);else expect(result.aborts).toBeGreaterThan(0);}catch(error){failures.push({mode,error:String(error)});}}
  expect(failures).toEqual([]);
 }finally{if(bucket){await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');const stages=(await bucket.list({prefix:'stage/'})).objects;for(const item of stages)await bucket.delete(item.key);expect(stages).toEqual([]);expect((await bucket.list()).objects).toEqual([]);}await mf.dispose();}
},120000);
