import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import {createFlacDecoder} from '@edge-ffmpeg/avcodec';
import {countFlacSamples} from '../../packages/avformat/src/flac-prepass.js';
import {executeFlacDecode} from '../../packages/avformat/src/flac-decode.js';
import corpus from '../../compat/behavior-specs/flac-prepass/cases.json' with {type:'json'};
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
it('pins independently generated Native prepass outputs',()=>{expect(createHash('sha256').update(wasm).digest('hex')).toBe(corpus.wasmSha256);});
for(const row of corpus.rows)it(`matches finite decoded Native ${row.id}`,async()=>{
 const bytes=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];let opens=0,commits=0,maxRead=0;
 const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module,maxReadBytes:31})},budget:{maxResidentBytes:33554432,maxBufferBytes:4096,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){opens++;return {size:BigInt(bytes.length),async readAt(at,length){maxRead=Math.max(maxRead,length);return bytes.subarray(Number(at),Number(at)+Math.min(7,length));}};},async openWrite(){return {async write(chunk){chunks.push(chunk.slice());},async commit(){commits++;},async abort(){}};}}});
 const result=await ffmpeg.exec(row.args);expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(row.exitCode);expect(Buffer.concat(chunks).toString('base64')).toBe(row.output);expect(opens).toBe(1);expect(commits).toBe(1);expect(maxRead).toBeLessThanOrEqual(31);
});
it('releases reservations after a provider synchronously throws',async()=>{
 const original=ResourceContext.prototype.reserveExternalMemory,contexts=new Set<ResourceContext>(),spy=vi.spyOn(ResourceContext.prototype,'reserveExternalMemory').mockImplementation(function(this:ResourceContext,bytes){contexts.add(this);return original.call(this,bytes);});
 try{
  const row=corpus.rows.find(row=>row.id==='1000/unknown/wav/-frames:a/2')!,input=Buffer.from(row.input,'base64');let aborts=0;
  const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module})},budget:{maxResidentBytes:33554432,maxBufferBytes:4096,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,len){return input.subarray(Number(at),Number(at)+len);}};},async openWrite(){return {write(){throw Error('synchronous provider write failure');},async commit(){throw Error('must not commit');},async abort(){aborts++;}};}}});
  expect((await ffmpeg.exec(row.args)).exitCode).not.toBe(0);expect(aborts).toBeGreaterThan(0);for(const context of contexts)expect(context.allocatedBytes).toBe(0);
 }finally{spy.mockRestore();}
});
// Track actual Core reservations rather than substituting a decoder or its memory.
function trackReservations(){
 const original=ResourceContext.prototype.reserveExternalMemory,contexts=new Set<ResourceContext>();let allocations=0,releases=0,active=0,peakActive=0,peak=0;
 const spy=vi.spyOn(ResourceContext.prototype,'reserveExternalMemory').mockImplementation(function(this:ResourceContext,bytes){
  contexts.add(this);const release=original.call(this,bytes);peak=Math.max(peak,this.allocatedBytes);
  if(bytes===16777216){allocations++;active++;peakActive=Math.max(peakActive,active);}
  let alive=true;return()=>{if(!alive)return;alive=false;release();if(bytes===16777216){active--;releases++;}};
 });
 return {contexts,restore:()=>spy.mockRestore(),get allocations(){return allocations;},get releases(){return releases;},get active(){return active;},get peakActive(){return peakActive;},get peak(){return peak;}};
}
const budget={maxResidentBytes:16842752,maxBufferBytes:4096,maxPendingPackets:8,maxCpuTimeMs:10000};
it.each([
 ['1000/known/wav/-frames:a/all',1],['1000/unknown/wav/-frames:a/all',2],
 ['1000/known/wav/-frames:a/0',1],['1000/unknown/wav/-frames:a/0',1],
 ['1000/known/wav/-frames:a/1',2],['1000/unknown/wav/-frames:a/2',2],
 ['1000/unknown/s16le/-frames:a/all',2],['1000/unknown/framecrc/-frames:a/2',1],
 ['0/unknown/wav/-frames:a/all',2],['257/known/wav/-frames:a/99',2],
] as const)('keeps one real decoder alive per pass under a single-instance budget: %s',async(id,passes)=>{
 const account=trackReservations();
 try{
  const row=corpus.rows.find(row=>row.id===id)!,input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];let opens=0,commits=0;
  const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module,maxReadBytes:31})},budget,filesystem:{async openRead(){opens++;return {size:BigInt(input.length),async readAt(at,len){return input.subarray(Number(at),Number(at)+Math.min(3,len));}};},async openWrite(){return {async write(chunk){chunks.push(chunk.slice());},async commit(){commits++;},async abort(){}};}}});
  const result=await ffmpeg.exec(row.args);expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(0);expect(Buffer.concat(chunks).toString('base64')).toBe(row.output);expect(opens).toBe(1);expect(commits).toBe(1);
  expect(account.allocations).toBe(passes);expect(account.releases).toBe(passes);expect(account.peakActive).toBe(1);expect(account.active).toBe(0);expect(account.peak).toBeGreaterThan(16777216);expect(account.peak).toBeLessThanOrEqual(budget.maxResidentBytes);for(const context of account.contexts)expect(context.allocatedBytes).toBe(0);
 }finally{account.restore();}
});
it('counts real decoded prefixes, releases every borrowed frame, and never allocates in the helper',async()=>{
 const account=trackReservations();
 try{
  const row=corpus.rows.find(row=>row.id==='1000/unknown/s16le/-frames:a/2')!,input=Buffer.from(row.input,'base64'),signal=new AbortController().signal,resources=new ResourceContext(budget,signal),scratch=resources.reserveExternalMemory(543);
  const source={size:BigInt(input.length),async readAt(at:bigint,len:number){return input.subarray(Number(at),Number(at)+Math.min(7,len));}};
  try{
   for(let pass=0;pass<2;pass++){
    const decoder=await createFlacDecoder(module,source,{signal,maxReadBytes:31,reserveExternalMemory:n=>resources.reserveExternalMemory(n)});
    try{
     const initial=await decoder.next();expect(initial.status).toBe('metadata');
     expect(await countFlacSamples(decoder,initial.metadata,2n,signal)).toBe(BigInt(Buffer.from(row.output,'base64').length/4));
     expect(account.allocations).toBe(pass+1);expect(resources.allocatedBytes).toBe(16777216+543);
     const next=await decoder.next();expect(next.status).toBe('frame');if(next.status==='frame')next.release();
    }finally{await decoder.close();await decoder.close();}
    expect(resources.allocatedBytes).toBe(543);
   }
  }finally{scratch();}
  expect(resources.allocatedBytes).toBe(0);expect(account.allocations).toBe(2);expect(account.releases).toBe(2);expect(account.peakActive).toBe(1);
 }finally{account.restore();}
});
it('rejects a decoder reservation exceeding Core capacity without opening output',async()=>{
 const account=trackReservations();
 try{
  const row=corpus.rows.find(row=>row.id==='1000/unknown/wav/-frames:a/2')!,input=Buffer.from(row.input,'base64');let writes=0;
  const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module,maxReadBytes:31})},budget:{...budget,maxResidentBytes:16777216},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,len){return input.subarray(Number(at),Number(at)+len);}};},async openWrite(){writes++;throw Error('must not open output');}}});
  expect((await ffmpeg.exec(row.args)).exitCode).not.toBe(0);expect(writes).toBe(0);expect(account.allocations).toBe(0);for(const context of account.contexts)expect(context.allocatedBytes).toBe(0);
 }finally{account.restore();}
});
it.each(['prepass','output-pass'] as const)('cancels a stalled real decoder %s and observes late provider rejection',async phase=>{
 const account=trackReservations(),abort=new AbortController(),reason=Error('cancel stalled '+phase);let rejectRead!:(error:Error)=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 try{
  const row=corpus.rows.find(row=>row.id==='1000/unknown/wav/-frames:a/2')!,input=Buffer.from(row.input,'base64');let outputOpens=0,commits=0;
  const pass=phase==='prepass'?1:2;
  const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module,maxReadBytes:31})},budget,filesystem:{async openRead(){return {size:BigInt(input.length),readAt(at,len){
   if(account.allocations===pass&&at>42n){entered();return new Promise<Uint8Array>((_resolve,reject)=>{rejectRead=reject;});}
   return Promise.resolve(input.subarray(Number(at),Number(at)+Math.min(7,len)));
  }};},async openWrite(){outputOpens++;return {async write(){},async commit(){commits++;},async abort(){}};}}});
  const pending=ffmpeg.exec(row.args,{signal:abort.signal});await started;abort.abort(reason);
  expect((await pending).exitCode).not.toBe(0);expect(outputOpens).toBe(0);expect(commits).toBe(0);expect(account.allocations).toBe(pass);expect(account.releases).toBe(pass);expect(account.active).toBe(0);
  rejectRead(Error('late provider rejection'));await new Promise<void>(resolve=>setTimeout(resolve,0));for(const context of account.contexts)expect(context.allocatedBytes).toBe(0);
 }finally{account.restore();}
});
it.each([1,2])('cleans the real decoder after a synchronous input failure in pass %s',async pass=>{
 const account=trackReservations();
 try{
  const row=corpus.rows.find(row=>row.id==='1000/unknown/wav/-frames:a/2')!,input=Buffer.from(row.input,'base64');let outputs=0,failures=0;
  const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module,maxReadBytes:31})},budget,filesystem:{async openRead(){return {size:BigInt(input.length),readAt(at,len){
   if(account.allocations===pass&&at>42n){failures++;throw Error('synchronous prepass read failure');}
   return Promise.resolve(input.subarray(Number(at),Number(at)+Math.min(7,len)));
  }};},async openWrite(){outputs++;throw Error('must not open output');}}});
  expect((await ffmpeg.exec(row.args)).exitCode).not.toBe(0);expect(failures).toBe(1);expect(outputs).toBe(0);expect(account.allocations).toBe(pass);expect(account.releases).toBe(pass);expect(account.active).toBe(0);for(const context of account.contexts)expect(context.allocatedBytes).toBe(0);
 }finally{account.restore();}
});
it('cleans the prepass decoder when the real decoded frame exceeds the configured frame bound',async()=>{
 const account=trackReservations();
 try{
  const row=corpus.rows.find(row=>row.id==='1000/unknown/wav/-frames:a/2')!,input=Buffer.from(row.input,'base64');let outputs=0;
  const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module,maxReadBytes:31,maxFrameBytes:1})},budget,filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,len){return input.subarray(Number(at),Number(at)+Math.min(7,len));}};},async openWrite(){outputs++;throw Error('must not open output');}}});
  expect((await ffmpeg.exec(row.args)).exitCode).not.toBe(0);expect(outputs).toBe(0);expect(account.allocations).toBe(1);expect(account.releases).toBe(1);expect(account.active).toBe(0);for(const context of account.contexts)expect(context.allocatedBytes).toBe(0);
 }finally{account.restore();}
});
