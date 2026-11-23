import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import corpus from '../../compat/behavior-specs/flac-copy-duration/cases.json' with {type:'json'};

it('copies FLAC duration through actual R2/workerd without a configured decoder and preserves atomic output on faults',async()=>{
 const root=resolve('tests/workers'),wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');
 const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const bundle=await build({entryPoints:[root+'/flac-backend-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const path of Object.keys(bundle.metafile!.inputs)){expect(path.startsWith('node:')).toBe(false);expect(path.startsWith('.build/')).toBe(false);}
 // The shared fixture imports the module for unrelated decode tests. missing-module
 // deliberately constructs createMediaBackend({}), proving copy needs no decoder.
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-copy-duration-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 type Result={exitCode:number;sha256:string|null;opens:number;stages:number;multipartLive:number;outputs:string[];maxWrite:number;diagnostics:{code:string;message:string}[]};
 const request=async(args:readonly string[],mode='missing-module')=>{
  const mapped=args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg);
  const response=await mf.dispatchFetch('https://flac-duration.test/?mode='+mode+'&args='+encodeURIComponent(JSON.stringify(mapped)));
  expect(response.status).toBe(200);return await response.json() as Result;
 };
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const row of corpus.rows.filter(row=>row.exitCode===0)){
   const input=Buffer.from(row.input,'base64');expect(hash(input)).toBe(row.inputSha256);
   await bucket.put('source/input.flac',input);await bucket.delete('output/result.raw');
   const result=await request(row.args);
   expect(result.exitCode,row.id+JSON.stringify(result.diagnostics)).toBe(0);expect(result.sha256,row.id).toBe(row.outputSha256);
   expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);expect(result.maxWrite).toBeLessThanOrEqual(65536);
  }
  const row=corpus.rows.find(row=>row.exitCode===0&&row.outputPackets.length>1)!;
  await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));
  const sentinel=Buffer.from('previous committed FLAC');
  for(const options of [['-ss','0.000001','-i','/in.flac'],['-i','/in.flac','-ss','0.000001'],['-i','/in.flac','-t','garbage'],['-i','/in.flac','-t','-1'],['-i','/in.flac','-to','0']]){
   await bucket.put('output/result.raw',sentinel);
   const result=await request(['-y',...options,'-vn','-c:a','copy','-f','flac','/out']);
   expect(result.exitCode).not.toBe(0);expect(result.opens).toBe(0);expect(result.outputs).toEqual([]);expect(result.sha256).toBe(hash(sentinel));expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);
  }
  // Fault modes use the same copy command with an available module; the public
  // no-decoder matrix above independently proves it is not a decoder dependency.
  for(const mode of ['cancel-write','write-failure','output-budget']){
   await bucket.put('output/result.raw',sentinel);
   const result=await request(['-y',...row.args],mode);
   expect(result.exitCode,mode).not.toBe(0);expect(result.sha256,mode).toBe(hash(sentinel));expect(result.outputs).toEqual([]);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);
  }
 }finally{
  if(bucket){await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');expect((await bucket.list()).objects).toEqual([]);}
  await mf.dispose();
 }
},120000);
