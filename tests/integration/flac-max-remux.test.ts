import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {expect,it,vi} from 'vitest';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import type {BackendContext} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {parseArgv} from '@edge-ffmpeg/cli';
import {executeFlacRemux} from '../../packages/avformat/src/flac-wave-remux.js';
import corpus from '../../compat/behavior-specs/flac-max-remux/cases.json' with {type:'json'};

const budget={maxResidentBytes:1048576,maxBufferBytes:34,maxPendingPackets:8,maxCpuTimeMs:10000};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const baseline=corpus.rows.find(row=>row.id==='16-2-ramp-5/default')!;
function setup(encoded=baseline.input,options:{failure?:'write'|'commit';controller?:AbortController;resident?:number;short?:number;existing?:string}={}){
 const bytes=Buffer.from(encoded,'base64'),controller=options.controller??new AbortController(),original=Buffer.from(options.existing??Buffer.from('existing output').toString('base64'),'base64');
 let published=original,reads=0,opens=0,commits=0,aborts=0,maxRead=0,maxWrite=0;
 const context:BackendContext={signal:controller.signal,budget:{...budget,maxResidentBytes:options.resident??budget.maxResidentBytes},filesystem:{
  async outputExists(){return options.existing!==undefined;},
  async openRead(){reads++;return {size:BigInt(bytes.length),async readAt(at,length){maxRead=Math.max(maxRead,length);return bytes.subarray(Number(at),Number(at)+Math.min(length,options.short??7));}};},
  async openWrite(){opens++;const chunks:Uint8Array[]=[];return {async write(chunk){maxWrite=Math.max(maxWrite,chunk.length);if(options.failure==='write')throw Error('injected write');chunks.push(chunk.slice());options.controller?.abort(Error('cancel write'));},async commit(){if(options.failure==='commit')throw Error('injected commit');commits++;published=Buffer.concat(chunks);},async abort(){aborts++;chunks.length=0;}};},
 }};
 return {context,original,get published(){return published;},get reads(){return reads;},get opens(){return opens;},get commits(){return commits;},get aborts(){return aborts;},get maxRead(){return maxRead;},get maxWrite(){return maxWrite;}};
}
function audioOffset(bytes:Buffer){expect(bytes.toString('ascii',0,4)).toBe('fLaC');let at=4;for(;;){expect(at+4).toBeLessThanOrEqual(bytes.length);const last=Boolean(bytes[at]!&128),size=bytes.readUIntBE(at+1,3);at+=4+size;expect(at).toBeLessThanOrEqual(bytes.length);if(last)return at;}}

it('uses independently captured pinned Native evidence, not generated expected bytes',()=>{
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 expect(corpus.limits.actualNativeCalls).toBeLessThanOrEqual(64);
 for(const row of corpus.rows){expect(sha(Buffer.from(row.input,'base64'))).toBe(row.inputSha256);if(row.output!==null)expect(sha(Buffer.from(row.output,'base64'))).toBe(row.outputSha256);}
});
// Native -blocksize is a file-protocol option, not a Workers provider contract.
// Equivalent short-provider-read behavior is exercised below without changing fixture argv.
for(const row of corpus.rows.filter(row=>row.exitCode===0&&!row.id.startsWith('short-read-')&&row.id!=='overwrite-n'))it(`direct real remux matches Native bytes and packet identities: ${row.id}`,async()=>{
 const run=setup(row.input,'existingOutput' in row?{existing:row.existingOutput}:{});
 await expect(executeFlacRemux(parseArgv(row.args),run.context)).resolves.toEqual(['/out']);
 const expected=Buffer.from(row.output!,'base64');expect(run.published).toEqual(expected);expect(run.commits).toBe(1);expect(run.aborts).toBe(0);expect(run.reads).toBe(1);expect(run.maxRead).toBeLessThanOrEqual(34);expect(run.maxWrite).toBeLessThanOrEqual(34);
 expect(run.published.subarray(8,42)).toEqual(Buffer.from(row.input,'base64').subarray(8,42));
 const start=audioOffset(run.published);let at=start;
 for(const packet of row.outputProbe!.packets){expect(sha(run.published.subarray(at,at+packet.bytes))).toBe(packet.dataSha256);at+=packet.bytes;}
 expect(at).toBe(run.published.length);
});
for(const short of [1,7])it(`matches the baseline with actual provider reads capped at ${short}`,async()=>{
 const run=setup(baseline.input,{short});await executeFlacRemux(parseArgv(baseline.args),run.context);expect(run.published).toEqual(Buffer.from(baseline.output!,'base64'));expect(run.reads).toBe(1);
});

for(const kind of ['success','write','commit','cancel','budget'] as const)it(`keeps publication atomic and Core ownership balanced: ${kind}`,async()=>{
 const contexts=new Set<ResourceContext>(),allocate=ResourceContext.prototype.allocate,reserve=ResourceContext.prototype.reserveExternalMemory;
 const allocation=vi.spyOn(ResourceContext.prototype,'allocate').mockImplementation(function(this:ResourceContext,bytes){contexts.add(this);return allocate.call(this,bytes);});
 const reservation=vi.spyOn(ResourceContext.prototype,'reserveExternalMemory').mockImplementation(function(this:ResourceContext,bytes){contexts.add(this);return reserve.call(this,bytes);});
 try{
  const run=setup(baseline.input,{...(kind==='write'||kind==='commit'?{failure:kind}:{}),...(kind==='cancel'?{controller:new AbortController()}:{}),...(kind==='budget'?{resident:34}:{})});
  const task=executeFlacRemux(parseArgv(baseline.args),run.context);
  if(kind==='success'){await task;expect(run.commits).toBe(1);}else{await expect(task).rejects.toBeDefined();expect(run.commits).toBe(0);expect(run.published).toEqual(run.original);if(kind==='budget')expect(run.opens).toBe(0);else expect(run.aborts).toBeGreaterThan(0);}
  await new Promise<void>(resolve=>setTimeout(resolve,0));expect(contexts.size).toBeGreaterThan(0);for(const resources of contexts)expect(resources.allocatedBytes).toBe(0);
 }finally{allocation.mockRestore();reservation.mockRestore();}
});

it('retains a supplied probed read generation without reopening input',async()=>{
 const bytes=Buffer.from(baseline.input,'base64'),run=setup();
 run.context.filesystem.openRead=async()=>{throw Error('must not reopen');};
 await executeFlacRemux(parseArgv(baseline.args),run.context,{size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}});
 expect(run.published).toEqual(Buffer.from(baseline.output!,'base64'));expect(run.reads).toBe(0);
});

it('refuses duplicate audio and existing no-overwrite destinations without publication',async()=>{
 const duplicate=corpus.rows.find(row=>row.id==='duplicate-audio')!,run=setup(duplicate.input);
 await expect(executeFlacRemux(parseArgv(duplicate.args),run.context)).rejects.toMatchObject({code:'unsupported-command'});expect(run.opens).toBe(0);
 const existing=corpus.rows.find(row=>row.id==='overwrite-n')!;
 if(existing.existingOutput===undefined)throw Error('Missing Native existing-output fixture');
 const refused=setup(existing.input,{existing:existing.existingOutput});
 // Native -nostdin -n returns zero with no output operation; Core reports output-exists.
 await expect(executeFlacRemux(parseArgv(existing.args),refused.context)).rejects.toMatchObject({code:'output-exists'});expect(refused.opens).toBe(0);expect(refused.published).toEqual(refused.original);
});

for(const options of [['-ss','1'],['-af','anull'],['-map_metadata','1'],['-frames:a','1.5']])it(`rejects unsupported or malformed policy before opening destination: ${options.join(' ')}`,async()=>{
 const run=setup(),command=parseArgv(['-i','/in.flac','-c:a','copy','-f','flac',...options,'/out']);
 await expect(executeFlacRemux(command,run.context)).rejects.toBeDefined();expect(run.opens).toBe(0);expect(run.commits).toBe(0);
});

it('rejects Native file-protocol -blocksize at the CLI boundary',()=>{
 expect(()=>parseArgv(['-blocksize','1','-i','/in.flac','-c:a','copy','-f','flac','/out'])).toThrow('Unsupported option: -blocksize');
});

it('bundles the actual production helper for browsers without Native, Node, or .build fallback',async()=>{
 const result=await build({entryPoints:['packages/avformat/src/flac-wave-remux.ts'],bundle:true,write:false,platform:'browser',format:'esm',metafile:true});
 expect(Object.keys(result.metafile!.inputs).some(path=>path.includes('.build/')||path.includes('runtime-node'))).toBe(false);
 expect(result.outputFiles[0]!.text).not.toMatch(/node:|child_process|\.build\//);
});

const positiveRows=corpus.rows.filter(row=>row.exitCode===0&&!row.id.startsWith('short-read-')&&row.id!=='overwrite-n');
// Translate only Native's file protocol read bound into the provider contract.
function providerArgs(args:readonly string[]){const index=args.indexOf('-blocksize');return index<0?[...args]:args.filter((_,at)=>at!==index&&at!==index+1);}
const providerRows=[...positiveRows,...corpus.rows.filter(row=>row.id.startsWith('short-read-'))];

it('matches supported Native remux rows through public FFmpeg and real Node atomic storage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'edge-flac-max-remux-'));
 try{
  for(const row of providerRows){
   await writeFile(join(root,'in.flac'),Buffer.from(row.input,'base64'));await rm(join(root,'out'),{force:true});
   if(row.existingOutput!==undefined)await writeFile(join(root,'out'),Buffer.from(row.existingOutput,'base64'));
   const filesystem=await createNodeFileSystem({root,maxReadBytes:34,maxWriteBytes:34});
   const short=row.inputReadBoundBytes??34;
   const frontend=new FFmpeg({filesystem:{...filesystem,async openRead(path){const source=await filesystem.openRead(path);return {size:source.size,readAt:(at,length,signal)=>source.readAt(at,Math.min(length,short),signal)};}},backend:createMediaBackend(),budget});
   const result=await frontend.exec(providerArgs(row.args));
   expect(result.exitCode,row.id+JSON.stringify(result.diagnostics)).toBe(0);expect(result.outputs,row.id).toEqual(['/out']);
   expect(await readFile(join(root,'out')),row.id).toEqual(Buffer.from(row.output!,'base64'));
   expect((await readdir(root)).sort(),row.id).toEqual(['in.flac','out']);
  }
 }finally{await rm(root,{recursive:true,force:true});}
},60000);

it('matches Native remux through public FFmpeg in actual workerd/R2 without Node compatibility',async()=>{
 const bundle=await build({stdin:{resolveDir:process.cwd(),sourcefile:'flac-max-remux-worker.ts',contents:`
  import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
  import {createMediaBackend} from '@edge-ffmpeg/avformat';
  import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
  export default {async fetch(request,env){
   const {args,short=4096,mode='success'}=await request.json(),controller=new AbortController(),contexts=new Set();
   const allocate=ResourceContext.prototype.allocate,reserve=ResourceContext.prototype.reserveExternalMemory;
   ResourceContext.prototype.allocate=function(bytes){contexts.add(this);return allocate.call(this,bytes);};
   ResourceContext.prototype.reserveExternalMemory=function(bytes){contexts.add(this);return reserve.call(this,bytes);};
   try{
    const fs=createR2FileSystem({bucket:env.BUCKET,mounts:{'/input':'input','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'stage',partBytes:5242880,maxWriteBytes:4096,maxOutputBytes:1048576}});
    let opens=0,maxRead=0,maxWrite=0;
    const filesystem={...fs,async openRead(path){opens++;const source=await fs.openRead(path);return {size:source.size,async readAt(at,length,signal){maxRead=Math.max(maxRead,length);return source.readAt(at,Math.min(length,short),signal);}};},async openWrite(path,options){const writer=await fs.openWrite(path,options);return {...writer,async write(bytes){maxWrite=Math.max(maxWrite,bytes.length);if(mode==='write')throw Error('injected write');await writer.write(bytes);if(mode==='cancel')controller.abort(Error('injected cancel'));}};}};
    const result=await new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:mode==='budget'?34:1048576,maxBufferBytes:mode==='budget'?34:4096,maxPendingPackets:8,maxCpuTimeMs:10000}}).exec(args,{signal:controller.signal});
    return Response.json({exitCode:result.exitCode,outputs:result.outputs,diagnostics:result.diagnostics,opens,maxRead,maxWrite,owned:[...contexts].map(context=>context.allocatedBytes)});
   }finally{ResourceContext.prototype.allocate=allocate;ResourceContext.prototype.reserveExternalMemory=reserve;}
  }};
 `},bundle:true,write:false,platform:'browser',format:'esm',metafile:true});
 for(const path of Object.keys(bundle.metafile!.inputs))expect(path).not.toMatch(/node:|runtime-node|\.build\//);
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports).toEqual([]);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['BUCKET']}));
 try{
  await mf.ready;const bucket=await mf.getR2Bucket('BUCKET');
  for(const row of providerRows){
   await bucket.put('input/in.flac',Buffer.from(row.input,'base64'));await bucket.delete('output/out');
   if(row.existingOutput!==undefined)await bucket.put('output/out',Buffer.from(row.existingOutput,'base64'));
   const args=providerArgs(row.args).map(value=>value==='/in.flac'?'/input/in.flac':value==='/out'?'/output/out':value);
   const response=await mf.dispatchFetch('https://remux.test/',{method:'POST',body:JSON.stringify({args,...('inputReadBoundBytes' in row?{short:row.inputReadBoundBytes}:{})})});
   expect(response.status,row.id).toBe(200);
   const result=await response.json() as {exitCode:number;outputs:string[];diagnostics:unknown[];opens:number;maxRead:number;maxWrite:number;owned:number[]};
   expect(result.exitCode,row.id+JSON.stringify(result.diagnostics)).toBe(0);expect(result.outputs,row.id).toEqual(['/output/out']);expect(result.opens).toBe(1);expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxWrite).toBeLessThanOrEqual(4096);expect(result.owned.length).toBeGreaterThan(0);expect(result.owned.every(bytes=>bytes===0)).toBe(true);
   const output=await bucket.get('output/out');expect(output,row.id).not.toBeNull();expect(Buffer.from(await output!.arrayBuffer()),row.id).toEqual(Buffer.from(row.output!,'base64'));
   expect((await bucket.list({prefix:'stage/'})).objects,row.id).toEqual([]);
  }
  for(const mode of ['write','cancel','budget']){
   await bucket.put('input/in.flac',Buffer.from(baseline.input,'base64'));await bucket.put('output/out','old output');
   const args=baseline.args.map(value=>value==='/in.flac'?'/input/in.flac':value==='/out'?'/output/out':value);
   const response=await mf.dispatchFetch('https://remux.test/',{method:'POST',body:JSON.stringify({args,mode})});
   expect(response.status,mode).toBe(200);
   const result=await response.json() as {exitCode:number;outputs:string[];owned:number[]};expect(result.exitCode,mode).not.toBe(0);expect(result.outputs,mode).toEqual([]);expect(result.owned.every(bytes=>bytes===0),mode).toBe(true);
   expect(await (await bucket.get('output/out'))!.text(),mode).toBe('old output');expect((await bucket.list({prefix:'stage/'})).objects,mode).toEqual([]);
  }
 }finally{await mf.dispose();}
},60000);
