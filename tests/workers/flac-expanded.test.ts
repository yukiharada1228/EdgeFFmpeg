import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

interface Row {id:string;input:string;inputSha256:string;args:string[];output:string|null;outputSha256:string|null;exitCode:number}
interface Result {exitCode:number;outputs:string[];size:number|null;sha256:string|null;reads:number;maxRead:number;writes:number;maxWrite:number;opens:number;aborts:number;stages:number;multipartLive:number;diagnostics:{code:string;message:string}[]}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

it('matches expanded finite FLAC prepass and AIFF/AU Native cases on actual R2/workerd',async()=>{
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');
 const corpora=['flac-prepass','flac-output'].map(name=>({name,...JSON.parse(readFileSync('compat/behavior-specs/'+name+'/cases.json','utf8')) as {wasmSha256:string;rows:Row[]}}));
 expect(corpora[0]!.rows).toHaveLength(162);expect(corpora[1]!.rows).toHaveLength(342);
 for(const corpus of corpora)expect(corpus.wasmSha256).toBe(sha(wasm));
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-backend-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-expanded-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 const failures:unknown[]=[];
 const request=(row:Row,mode='normal',extra:string[]=[])=>mf.dispatchFetch('https://flac-expanded.test/?mode='+mode+'&args='+encodeURIComponent(JSON.stringify([...extra,...row.args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg)])));
 const clean=(result:Result)=>{expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxWrite).toBeLessThanOrEqual(65536);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);};
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const corpus of corpora)for(const row of corpus.rows){
   try{
    const bytes=Buffer.from(row.input,'base64');expect(sha(bytes)).toBe(row.inputSha256);expect(bytes.length).toBeLessThanOrEqual(1048576);
    await bucket.put('source/input.flac',bytes);await bucket.delete('output/result.raw');
    const response=await request(row);
    expect(response.status).toBe(200);const result=await response.json() as Result;
    expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(row.exitCode);
    if(row.exitCode===0){const output=Buffer.from(row.output!,'base64');expect(sha(output)).toBe(row.outputSha256);expect(result.sha256).toBe(row.outputSha256);expect(result.size).toBe(output.length);expect(result.outputs).toEqual(['/output/result.raw']);expect(result.opens).toBe(1);expect(result.reads).toBeGreaterThan(1);}
    else{expect(result.outputs).toEqual([]);expect(result.size).toBeNull();}
    clean(result);
   }catch(error){failures.push({corpus:corpus.name,id:row.id,error:String(error)});}
  }
  // Exercise new muxers' rollback, rather than relying on older WAV coverage.
  for(const format of ['aiff','au']){
   const row=corpora[1]!.rows.find(row=>row.id===`32-2-extremes-5/${format}`);if(!row)throw Error(`Missing ${format} rollback fixture`);
   const bytes=Buffer.from(row.input,'base64'),sentinel=Buffer.from(`previous ${format} output`);
   for(const mode of ['cancel-write','write-failure','output-budget','missing-module','malformed']){
    try{
     await bucket.put('source/input.flac',mode==='malformed'?bytes.subarray(0,bytes.length-5):bytes);await bucket.put('output/result.raw',sentinel);
     const response=await request(row,mode==='malformed'?'normal':mode,['-y']);expect(response.status).toBe(200);const result=await response.json() as Result;
     expect(result.exitCode,JSON.stringify(result.diagnostics)).not.toBe(0);expect(result.outputs).toEqual([]);expect(result.sha256).toBe(sha(sentinel));expect(result.size).toBe(sentinel.length);clean(result);
     const published=await bucket.get('output/result.raw');expect(published).not.toBeNull();expect(sha(new Uint8Array(await published!.arrayBuffer()))).toBe(sha(sentinel));
     if(mode==='missing-module')expect(result.opens).toBe(0);else if(mode!=='malformed')expect(result.aborts).toBeGreaterThan(0);
    }catch(error){failures.push({format,mode,error:String(error)});}
   }
  }
  expect(failures).toEqual([]);
 }finally{
  try{if(bucket){await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');const stages=(await bucket.list({prefix:'stage/'})).objects;for(const item of stages)await bucket.delete(item.key);expect(stages).toEqual([]);expect((await bucket.list()).objects).toEqual([]);}}finally{await mf.dispose();}
 }
},120000);
