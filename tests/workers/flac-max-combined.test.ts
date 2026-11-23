import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import corpus from '../../compat/behavior-specs/flac-max-combined/cases.json' with {type:'json'};
import scalar from '../../compat/behavior-specs/flac-max-combined/scalar.json' with {type:'json'};
import remux from '../../compat/behavior-specs/flac-max-remux/cases.json' with {type:'json'};
import selection from '../../compat/behavior-specs/flac-max-selection/cases.json' with {type:'json'};
import arithmeticProfile from '../../compat/behavior-specs/flac-max-remix/arithmetic.json' with {type:'json'};

it('runs combined FLAC features through the public backend on actual R2/workerd',async()=>{
 const root=resolve('tests/workers'),wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');
 const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
 expect(hash(wasm)).toBe(corpus.wasmSha256);
 const bundle=await build({entryPoints:[root+'/flac-backend-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const path of Object.keys(bundle.metafile!.inputs)){expect(path.startsWith('node:')).toBe(false);expect(path.startsWith('.build/')).toBe(false);}
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-combined-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 const failures:unknown[]=[];
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  const remuxRows=remux.rows.filter(row=>row.id!=='overwrite-n'&&row.exitCode===0);
  for(const row of [...corpus.rows,...scalar.rows,...remuxRows]){
   const input=Buffer.from(row.input,'base64');expect(hash(input)).toBe(row.inputSha256);
   await bucket.put('source/input.flac',input);await bucket.delete('output/result.raw');
   const args=row.args.filter((arg,index,argv)=>arg!=='-blocksize'&&argv[index-1]!=='-blocksize').map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg);
   try{
    const response=await mf.dispatchFetch('https://flac-combined.test/?args='+encodeURIComponent(JSON.stringify(args)));
    expect(response.status).toBe(200);
    const result=await response.json() as {exitCode:number;sha256:string|null;opens:number;stages:number;multipartLive:number;maxWrite:number;diagnostics:{code:string;message:string}[]};
    // Retain Native-positive input seeks as explicit unsupported cases rather
    // than misreporting an expected rejection as Native output parity.
    if(row.args.slice(0,row.args.indexOf('-i')).includes('-ss')){
     expect(row.exitCode).toBe(0);expect(result.exitCode).not.toBe(0);expect(result.opens).toBe(0);expect(result.sha256).toBeNull();
     expect(result.diagnostics[0]?.code).toBe('unsupported-command');expect(result.diagnostics[0]?.message).toMatch(/demux seeking/);
     expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);continue;
    }
    if(!row.args.includes('-cpuflags')&&(row.args.includes('-ar')||row.id.endsWith('/volume-remix')||row.id.startsWith('24-')&&row.id.endsWith('/pad-remix'))){
     expect(row.exitCode).toBe(0);expect(result.exitCode).not.toBe(0);expect(result.opens).toBe(0);expect(result.sha256).toBeNull();expect(result.diagnostics[0]?.message).toMatch(/requires -cpuflags 0/);
     expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);continue;
    }
    expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(row.exitCode);expect(result.sha256).toBe(row.outputSha256);
    expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);expect(result.maxWrite).toBeLessThanOrEqual(65536);
   }catch(error){failures.push({id:row.id,error:String(error)});}
  }
  {
   const row=arithmeticProfile.scalarCase;await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));await bucket.delete('output/result.raw');
   const args=row.args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg);
   try{const response=await mf.dispatchFetch('https://flac-combined.test/?arithmetic=fused&args='+encodeURIComponent(JSON.stringify(args)));const result=await response.json() as {exitCode:number;sha256:string;stages:number;multipartLive:number};expect(result.exitCode).toBe(0);expect(result.sha256).toBe(row.outputSha256);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);}catch(error){failures.push({id:row.id,error:String(error)});}
  }
  for(const row of selection.rows){
   await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));await bucket.delete('output/result.raw');
   const args=row.args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg);
   try{
    const response=await mf.dispatchFetch('https://flac-combined.test/?args='+encodeURIComponent(JSON.stringify(args)));
    const result=await response.json() as {exitCode:number;sha256:string|null;opens:number;stages:number;multipartLive:number;diagnostics:{message:string}[]};
    if(row.exitCode===0&&row.selectedStreamIds.some(id=>id>0)){expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/attached pictures/);expect(result.opens).toBe(0);expect(result.sha256).toBeNull();}
    else{expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(row.exitCode);if(row.exitCode===0)expect(result.sha256).toBe(row.outputSha256);else{expect(result.opens).toBe(0);expect(result.sha256).toBeNull();}}
    expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);
   }catch(error){failures.push({id:row.id,error:String(error)});}
  }
  // A WAV header guarantees a second write where the fixture injects failure.
  for(const row of [scalar.rows.find(row=>row.id==='16-2-ramp-5/known/volume-resample/scalar')!,remuxRows.find(row=>row.id==='16-2-ramp-5/default')!]){
   await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));
   const sentinel=Buffer.from('previous committed media');
   const args=['-y',...row.args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg)];
   for(const mode of ['cancel-write','write-failure','output-budget']){
    await bucket.put('output/result.raw',sentinel);
    try{
     const response=await mf.dispatchFetch('https://flac-combined.test/?mode='+mode+'&args='+encodeURIComponent(JSON.stringify(args)));
     const result=await response.json() as {exitCode:number;sha256:string;stages:number;multipartLive:number;outputs:string[]};
     expect(result.exitCode).not.toBe(0);expect(result.sha256).toBe(hash(sentinel));expect(result.outputs).toEqual([]);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);
    }catch(error){failures.push({id:row.id,mode,error:String(error)});}
   }
  }
  expect(failures,JSON.stringify(failures)).toEqual([]);
 }finally{
  if(bucket){await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');expect((await bucket.list()).objects).toEqual([]);}
  await mf.dispose();
 }
},120000);
