import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {expect,it,vi} from 'vitest';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import {parseArgv} from '@edge-ffmpeg/cli';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {executeFlacDecode} from '../../packages/avformat/src/flac-decode.js';
import corpus from '../../compat/behavior-specs/flac-output/cases.json' with {type:'json'};
import previous from '../../compat/behavior-specs/flac-decode-cli/cases.json' with {type:'json'};

const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
const budget={maxResidentBytes:33554432,maxBufferBytes:128,maxPendingPackets:8,maxCpuTimeMs:10000};
function setup(input:string,options:{failure?:'write'|'commit';controller?:AbortController;resident?:number;buffer?:number}={}){
 const inputBytes=Buffer.from(input,'base64'),published=new Map<string,Buffer>(),original=Buffer.from('existing output');published.set('/out',original);
 let reads=0,opens=0,commits=0,aborts=0,maxRead=0,maxWrite=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module,maxReadBytes:31}}),budget:{...budget,maxResidentBytes:options.resident??budget.maxResidentBytes,maxBufferBytes:options.buffer??budget.maxBufferBytes},filesystem:{
  async outputExists(){return false;},
  async openRead(){reads++;return {size:BigInt(inputBytes.length),async readAt(at,length){maxRead=Math.max(maxRead,length);return inputBytes.subarray(Number(at),Number(at)+Math.min(length,7));}};},
  async openWrite(path){opens++;const chunks:Uint8Array[]=[];return {
   async write(chunk){maxWrite=Math.max(maxWrite,chunk.length);if(options.failure==='write')throw Error('injected write failure');chunks.push(chunk.slice());options.controller?.abort(Error('cancel output'));},
   async commit(){if(options.failure==='commit')throw Error('injected commit failure');commits++;published.set(path,Buffer.concat(chunks));},
   async abort(){aborts++;chunks.length=0;},
  };},
 }});
 return {ffmpeg,published,original,get reads(){return reads;},get opens(){return opens;},get commits(){return commits;},get aborts(){return aborts;},get maxRead(){return maxRead;},get maxWrite(){return maxWrite;}};
}
function row(id:string){const value=corpus.rows.find(item=>item.id===id);if(!value)throw Error('Missing pinned output row '+id);return value;}
it('uses the independently pinned real module and complete output corpus',()=>{
 expect(createHash('sha256').update(wasm).digest('hex')).toBe(corpus.wasmSha256);
 expect(corpus.rows).toHaveLength(342);
});
for(const entry of corpus.rows)it(`public backend matches pinned Native bytes: ${entry.id}`,async()=>{
 const run=setup(entry.input),result=await run.ffmpeg.exec(entry.args);
 expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(entry.exitCode);
 expect(run.published.get('/out')).toEqual(Buffer.from(entry.output,'base64'));
 expect(run.commits).toBe(1);expect(run.aborts).toBe(0);expect(run.reads).toBe(1);
 expect(run.maxRead).toBeLessThanOrEqual(31);expect(run.maxWrite).toBeLessThanOrEqual(128);
});
for(const format of ['aiff','au'])for(const extension of format==='aiff'?['aiff','aif','aifc']:['au','snd'])it(`public backend defaults .${extension} to pcm_s16be`,async()=>{
 const entry=row('24-2-extremes-5/'+format),run=setup(entry.input),path='/out.'+extension;
 const result=await run.ffmpeg.exec(['-i','/in.flac','-map','0:a','-map_metadata','-1',path]);
 expect(result.diagnostics).toEqual([]);expect(run.published.get(path)).toEqual(Buffer.from(entry.output,'base64'));expect(run.reads).toBe(1);
});
for(const aliases of [['-acodec','-c'],['-c','-codec'],['-codec:a:0','-acodec'],['-acodec','-codec:0']])it(`honors ordered codec aliases ${aliases.join(' then ')}`,async()=>{
 const entry=row('16-2-ramp-5/aiff/pcm_s16le'),run=setup(entry.input);
 const result=await run.ffmpeg.exec(['-i','/in.flac','-map_metadata','-1',aliases[0]!,'copy',aliases[1]!,'pcm_s16le','-f','aiff','/out']);
 expect(result.diagnostics).toEqual([]);expect(run.published.get('/out')).toEqual(Buffer.from(entry.output,'base64'));
});
for(const format of ['aiff','au'])it(`rejects unsupported ${format} codecs and malformed options before output effects`,async()=>{
 const entry=row('16-2-ramp-5/'+format);
 for(const args of [['-c:a','mp3'],['-c:a','pcm_f32le'],['-frames:a','1.5'],['-map','0:1'],['-fflags','unknown'],['-map_metadata','1']]){
  const run=setup(entry.input),result=await run.ffmpeg.exec(['-i','/in.flac','-map_metadata','-1','-f',format,...args,'/out']);
  expect(result.exitCode).not.toBe(0);expect(run.opens).toBe(0);expect(run.commits).toBe(0);expect(run.published.get('/out')).toEqual(run.original);
 }
});
it('rejects malformed direct backend values before even opening the source',async()=>{
 for(const option of [{name:'-c:a',value:null},{name:'-f',value:null},{name:'-vn',value:'1'},{name:'-map',value:''}]){
  let effects=0;const command=parseArgv(['-i','/in.flac','/out.aiff']);command.outputs[0]!.options.push(option);
  await expect(executeFlacDecode(command,{signal:new AbortController().signal,budget,filesystem:{async openRead(){effects++;throw Error('unexpected read');},async openWrite(){effects++;throw Error('unexpected write');}}},{module})).rejects.toMatchObject({code:'invalid-arguments'});
  expect(effects).toBe(0);
 }
});
for(const format of ['aiff','au'])it(`validates unrepresentable ${format} headers before opening a transaction`,async()=>{
 const entry=row('16-2-ramp-5/'+format),bytes=Buffer.from(entry.input,'base64');
 bytes.writeBigUInt64BE((bytes.readBigUInt64BE(18)&~((1n<<36n)-1n))|0xfffffffffn,18);
 const run=setup(bytes.toString('base64')),result=await run.ffmpeg.exec(entry.args);
 expect(result.exitCode).not.toBe(0);expect(run.opens).toBe(0);expect(run.commits).toBe(0);
});
for(const format of ['aiff','au'])it(`rolls back ${format} failures/cancellation and releases all Core/Wasm reservations`,async()=>{
 const contexts=new Set<ResourceContext>(),reserve=ResourceContext.prototype.reserveExternalMemory;
 const spy=vi.spyOn(ResourceContext.prototype,'reserveExternalMemory').mockImplementation(function(this:ResourceContext,bytes){contexts.add(this);return reserve.call(this,bytes);});
 try{
  for(const kind of ['success','write','commit','cancel','budget'] as const){
   const controller=new AbortController(),entry=row('32-2-extremes-5/'+format+'/pcm_f64be'),run=setup(entry.input,{...(kind==='write'||kind==='commit'?{failure:kind}:{}),...(kind==='cancel'?{controller}:{}),...(kind==='budget'?{resident:16777216}:{})});
   const result=await run.ffmpeg.exec(entry.args,{signal:controller.signal});
   if(kind==='success'){expect(result.exitCode).toBe(0);expect(run.commits).toBe(1);}else{expect(result.exitCode).not.toBe(0);expect(run.commits).toBe(0);expect(run.published.get('/out')).toEqual(run.original);if(kind==='budget')expect(run.opens).toBe(0);else expect(run.aborts).toBeGreaterThan(0);}
   await new Promise<void>(resolve=>setTimeout(resolve,0));for(const resources of contexts)expect(resources.allocatedBytes).toBe(0);
  }
 }finally{spy.mockRestore();}
});
for(const format of ['aiff','au'])it(`supports zero frames and unknown-length ${format} without reopening the source`,async()=>{
 const entry=row('24-2-ramp-5/'+format),empty=row('24-2-empty-5/'+format),zero=setup(entry.input);
 expect((await zero.ffmpeg.exec([...entry.args.slice(0,-1),'-frames:a','0','/out'])).diagnostics).toEqual([]);expect(zero.published.get('/out')).toEqual(Buffer.from(empty.output,'base64'));
 const bytes=Buffer.from(entry.input,'base64');bytes.writeBigUInt64BE(bytes.readBigUInt64BE(18)&~((1n<<36n)-1n),18);
 const unknown=setup(bytes.toString('base64'));expect((await unknown.ffmpeg.exec(entry.args)).diagnostics).toEqual([]);expect(unknown.published.get('/out')).toEqual(Buffer.from(entry.output,'base64'));expect(unknown.reads).toBe(1);
 const prefix=setup(entry.input);expect((await prefix.ffmpeg.exec([...entry.args.slice(0,-1),'-frames:a','2','/out'])).diagnostics).toEqual([]);expect(prefix.published.get('/out')).toEqual(Buffer.from(entry.output,'base64'));expect(prefix.reads).toBe(1);
});
for(const format of ['aiff','au'])for(const late of ['resolve','reject'] as const)it(`cancels a stalled ${format} transaction and observes late ${late}`,async()=>{
 const entry=row('32-2-extremes-5/'+format),bytes=Buffer.from(entry.input,'base64'),controller=new AbortController();
 let ready!:()=>void,resolve!:()=>void,reject!:(error:unknown)=>void,commits=0,aborts=0;
 const started=new Promise<void>(done=>{ready=done;}),pending=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});
 const contexts=new Set<ResourceContext>(),reserve=ResourceContext.prototype.reserveExternalMemory;
 const spy=vi.spyOn(ResourceContext.prototype,'reserveExternalMemory').mockImplementation(function(this:ResourceContext,bytes){contexts.add(this);return reserve.call(this,bytes);});
 try{
  const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),budget,filesystem:{async openRead(){return {size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(){ready();await pending;},async commit(){commits++;},async abort(){aborts++;}};}}});
  const task=ffmpeg.exec(entry.args,{signal:controller.signal});await started;controller.abort(Error('cancel stalled output'));
  expect((await task).exitCode).not.toBe(0);expect(commits).toBe(0);
  if(late==='resolve')resolve();else reject(Error('late output rejection'));
  await new Promise<void>(done=>setTimeout(done,0));for(const resources of contexts)expect(resources.allocatedBytes).toBe(0);expect(commits).toBe(0);expect(aborts).toBeGreaterThan(0);
 }finally{resolve();spy.mockRestore();}
});
for(const format of ['wav','s16le','framecrc'])it(`preserves existing public ${format} output bytes`,async()=>{
 const entry=previous.rows.find(item=>item.id==='16-2-extremes-5/'+format);if(!entry)throw Error('Missing old output row');
 const run=setup(entry.input,{buffer:65536}),result=await run.ffmpeg.exec(entry.args);expect(result.diagnostics).toEqual([]);expect(run.published.get('/out')).toEqual(Buffer.from(entry.output,'base64'));
});
it('keeps the wired production route browser-only without Native or .build dependencies',async()=>{
 const result=await build({entryPoints:['packages/avformat/src/flac-decode.ts'],bundle:true,write:false,platform:'browser',format:'esm',metafile:true});
 expect(Object.keys(result.metafile!.inputs).some(path=>path.includes('.build/')||path.includes('runtime-node'))).toBe(false);
 expect(result.outputFiles[0]!.text).not.toMatch(/node:|child_process|\.build\//);
});
