import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import corpus from '../../compat/behavior-specs/flac-aformat-constraints/cases.json' with {type:'json'};
it('runs FLAC aformat identity constraints through actual R2/workerd without Node compatibility',async()=>{
 const root=resolve('tests/workers'),wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');
 const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');expect(hash(wasm)).toBe(corpus.wasmSha256);expect(corpus.rows).toHaveLength(16);
 const bundle=await build({entryPoints:[root+'/flac-backend-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const path of Object.keys(bundle.metafile!.inputs)){expect(path.startsWith('node:')).toBe(false);expect(path.startsWith('.build/')).toBe(false);}
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-aformat-constraints-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 type Result={exitCode:number;sha256:string|null;opens:number;stages:number;multipartLive:number;maxWrite:number;outputs:string[];diagnostics:{code:string;message:string}[]};
 const invoke=async(args:string[],mode='normal')=>{const response=await mf.dispatchFetch('https://flac-timed.test/?mode='+mode+'&args='+encodeURIComponent(JSON.stringify(args)));expect(response.status).toBe(200);return await response.json() as Result;};
 const mapArgs=(args:readonly string[])=>args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg);
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const row of corpus.rows){
   const input=Buffer.from(row.input,'base64');expect(hash(input)).toBe(row.inputSha256);await bucket.put('source/input.flac',input);await bucket.delete('output/result.raw');
   const result=await invoke(mapArgs(row.args));expect(result.exitCode,JSON.stringify({id:row.id,diagnostics:result.diagnostics})).toBe(row.exitCode);expect(result.diagnostics).toEqual([]);expect(result.sha256,row.id).toBe(row.outputSha256);expect(result.opens).toBe(1);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);expect(result.maxWrite).toBeLessThanOrEqual(65536);
   const output=await bucket.get('output/result.raw');expect(output,row.id).not.toBeNull();expect(Buffer.from(await output!.arrayBuffer()).toString('base64'),row.id).toBe(row.output);
  }
  const sentinel=Buffer.from('previous committed media');
  const rejected=[
   ...['aformat=sample_rates=16000','aformat=channel_layouts=mono','aformat=r=16000','aformat=cl=mono'].map(filter=>['-cpuflags','0','-i','/input/input.flac','-af',filter,'-f','s16le','/output/result.raw']),
 ...['aformat=sample_rates=16000','aformat=channel_layouts=mono'].flatMap(filter=>[
  ['-cpuflags','0','-i','/input/input.flac','-af',filter,'-t','0','-f','s16le','/output/result.raw'],
  ['-cpuflags','0','-i','/input/input.flac','-af',filter,'-frames:a','0','-f','s16le','/output/result.raw'],
 ]),
  ];
  for(const args of rejected){
   await bucket.put('output/result.raw',sentinel);const result=await invoke(['-y',...args]);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code,JSON.stringify(result.diagnostics)).toBe('execution-failed');expect(result.diagnostics[0]?.message).toMatch(/constraint|rate|layout|aformat/i);expect(result.opens).toBe(0);expect(result.sha256).toBe(hash(sentinel));expect(result.outputs).toEqual([]);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);
  }
  const row=corpus.rows.find(row=>row.args.includes('wav')&&!row.id.includes('past-eof'))!;
  await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));
  for(const mode of ['cancel-write','write-failure','output-budget']){
   await bucket.put('output/result.raw',sentinel);const result=await invoke(['-y',...mapArgs(row.args)],mode);expect(result.exitCode,mode).not.toBe(0);expect(result.sha256,mode).toBe(hash(sentinel));expect(result.outputs).toEqual([]);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);
  }
 }finally{if(bucket){await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');expect((await bucket.list()).objects).toEqual([]);}await mf.dispose();}
},120000);
