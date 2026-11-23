import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import corpus from '../../compat/behavior-specs/flac-cli/cases.json' with {type:'json'};
function setup(bytes=Buffer.from(corpus.input,'base64'),options:{exists?:boolean;failWrite?:boolean;controller?:AbortController;buffer?:number}={}){
 let commits=0,aborts=0,opens=0,maxRead=0,maxWrite=0;const chunks:Uint8Array[]=[];
 const ffmpeg=new FFmpeg({backend:createMediaBackend(),budget:{maxBufferBytes:options.buffer??34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async outputExists(){return options.exists??false;},async openRead(){return {size:BigInt(bytes.length),async readAt(at:bigint,length:number){maxRead=Math.max(maxRead,length);return bytes.subarray(Number(at),Number(at)+Math.min(length,7));}};},async openWrite(){opens++;return {async write(chunk:Uint8Array){maxWrite=Math.max(maxWrite,chunk.length);if(options.failWrite)throw Error('write failed');chunks.push(chunk.slice());options.controller?.abort(Error('cancel output'));},async commit(){commits++;},async abort(){aborts++;}};}}});
 return {ffmpeg,get commits(){return commits;},get aborts(){return aborts;},get opens(){return opens;},get maxRead(){return maxRead;},get maxWrite(){return maxWrite;},text:()=>Buffer.concat(chunks).toString()};
}
for(const row of corpus.rows.filter(row=>row.id!=='metadata'))it(`matches fresh pinned Native ${row.id} with short reads`,async()=>{const run=setup(),result=await run.ffmpeg.exec(row.args);expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(0);expect(run.text()).toBe(row.stdout);expect(run.commits).toBe(1);expect(run.maxRead).toBeLessThanOrEqual(34);expect(run.maxWrite).toBeLessThanOrEqual(34);});
it('refuses existing output and conflicting overwrite modes before creation',async()=>{for(const options of [['-n'],['-y','-n']]){const run=setup(undefined,{exists:true}),result=await run.ffmpeg.exec([...options,...corpus.rows[0]!.args]);expect(result.outputs).toEqual([]);expect(run.opens).toBe(0);expect(result.diagnostics[0]?.code).toBe(options.length===1?'output-exists':'invalid-arguments');}});
it('allows overwrite and aborts failed or cancelled writes without publishing',async()=>{const overwrite=setup(undefined,{exists:true});expect((await overwrite.ffmpeg.exec(['-y',...corpus.rows[0]!.args])).exitCode).toBe(0);for(const cancel of [false,true]){const controller=new AbortController(),run=setup(undefined,cancel?{controller}:{failWrite:true}),result=await run.ffmpeg.exec(corpus.rows[0]!.args,{signal:controller.signal});expect(result.outputs).toEqual([]);expect(run.commits).toBe(0);expect(run.aborts).toBeGreaterThan(0);}});
it('rejects unsupported selected semantics before output creation',async()=>{for(const opts of [['-map','0:3'],['-an'],['-ss','1'],['-af','anull'],['-c:a','pcm_s16le']]){const run=setup(),args=[...corpus.rows[0]!.args.slice(0,-1),...opts,'/output.crc'],result=await run.ffmpeg.exec(args);expect(result.exitCode).not.toBe(0);expect(run.opens).toBe(0);}});
it('does not force FLAC from an extension and rejects explicitly declared malformed input',async()=>{const run=setup(Buffer.from('not a flac'));const result=await run.ffmpeg.exec(['-f','flac','-i','/input.flac','-c','copy','-f','framecrc','/out']);expect(result.exitCode).not.toBe(0);expect(run.opens).toBe(0);});

it('matches pinned metadata options through the frontend',async()=>{const run=setup(),row=corpus.rows.find(row=>row.id==='metadata')!,result=await run.ffmpeg.exec(row.args);expect(result.exitCode).toBe(0);expect(run.text()).toBe(row.stdout);expect(run.commits).toBe(1);});

import pictures from '../../compat/behavior-specs/flac-demux/metadata.json' with {type:'json'};
import {parseArgv} from '@edge-ffmpeg/cli';
it('rejects selected attached pictures instead of silently dropping them',async()=>{const row=pictures.rows.find(row=>'pictures' in row.native&&row.native.pictures.length>0)!;const run=setup(Buffer.from(row.input,'base64'),{buffer:65536}),result=await run.ffmpeg.exec(corpus.rows[0]!.args);expect(result.exitCode).toBe(1);expect(result.diagnostics[0]?.message).toMatch(/attached pictures/);expect(run.opens).toBe(0);});
it('applies metadata semantics when invoked through the public backend command contract',async()=>{const run=setup(),row=corpus.rows.find(row=>row.id==='metadata')!,base=parseArgv(corpus.rows[0]!.args);base.outputs[0]!.options.push({name:'-map_metadata',value:'-1'},{name:'-metadata',value:'title=changed'});
 // Exercise the public backend ParsedCommand contract independently of the frontend.
 const input=Buffer.from(corpus.input,'base64'),chunks:Uint8Array[]=[];
 await createMediaBackend().execute(base,{budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},signal:new AbortController().signal,filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(data){chunks.push(data.slice());},async commit(){},async abort(){}};}}});expect(Buffer.concat(chunks).toString()).toBe(row.stdout);expect(run.opens).toBe(0);
});
for(const row of corpus.errors)it(`matches pinned Native failure status ${row.id}`,async()=>{const run=setup(),result=await run.ffmpeg.exec(['-i','/input.bin',...row.options,'-c','copy','-f','framecrc','/output.crc']);expect(result.exitCode).toBe(row.exitCode);expect(run.opens).toBe(0);});
it('uses magic even when a FLAC copy input has an MP4 filename',async()=>{const run=setup(),args=corpus.rows[0]!.args.map(arg=>arg==='/input.bin'?'/misnamed.mp4':arg),result=await run.ffmpeg.exec(args);expect(result.exitCode).toBe(0);expect(run.text()).toBe(corpus.rows[0]!.stdout);});
it('honors ordered codec overrides and refuses duplicate per-stream limits',async()=>{const run=setup(),args=['-i','/input.bin','-c','pcm_s16le','-c:a','copy','-f','framecrc','/output.crc'];expect((await run.ffmpeg.exec(args)).exitCode).toBe(0);const limited=setup(),result=await limited.ffmpeg.exec(['-i','/input.bin','-map','0:a','-map','0:a','-c','copy','-frames:a:0','1','-f','framecrc','/output.crc']);expect(result.diagnostics[0]?.message).toMatch(/duplicate-map frame limits/);expect(limited.opens).toBe(0);});
it('keeps unsupported pictures selected until every matching identity is removed',async()=>{
 const row=pictures.rows.find(row=>'pictures' in row.native&&row.native.pictures.length===2)!;
 for(const maps of [ ['0','-0:1'],['0','-0:v:0'],['0:v:1','0:a'],['0:2','0:a'],['0','-0:2'] ]){
  const run=setup(Buffer.from(row.input,'base64'),{buffer:65536});
  const result=await run.ffmpeg.exec(['-i','/input.bin',...maps.flatMap(map=>['-map',map]),'-c','copy','-f','framecrc','/out']);
  expect(result.diagnostics[0]?.message,maps.join(' ')).toMatch(/attached pictures/);expect(run.opens).toBe(0);
 }
 for(const maps of [['0','-0:1','-0:2'],['0','-0:v'],['0','-0:v:0','-0:v:1']]){
  const run=setup(Buffer.from(row.input,'base64'),{buffer:65536});
  expect((await run.ffmpeg.exec(['-i','/input.bin',...maps.flatMap(map=>['-map',map]),'-c','copy','-f','framecrc','/out'])).exitCode).toBe(0);
 }
});

import {vi} from 'vitest';
import {wantsFlacCopy,executeFlacCopy} from '../../packages/avformat/src/flac-copy.js';
import type {BackendContext} from '@edge-ffmpeg/core';
for(const phase of ['probe','extradata'] as const)for(const late of ['resolve','reject'] as const)it(`aborts stalled ${phase} reads promptly and observes late ${late}`,async()=>{
 const controller=new AbortController(),reason=new Error(`cancel ${phase}`),input=Buffer.from(corpus.input,'base64');
 let finish!:(bytes:Uint8Array)=>void,fail!:(reason:unknown)=>void,started!:()=>void,opens=0;
 const ready=new Promise<void>(resolve=>{started=resolve;}),pending=new Promise<Uint8Array>((resolve,reject)=>{finish=resolve;fail=reject;});
 const remove=vi.spyOn(controller.signal,'removeEventListener');
 const context:BackendContext={signal:controller.signal,budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{
  async openRead(){return {size:BigInt(input.length),async readAt(at,length,signal){
   // Demux reads use its local lifetime signal; direct probe/extradata reads use the parent.
   if(signal===controller.signal){started();return pending;}
   return input.subarray(Number(at),Number(at)+length);
  }};},async openWrite(){opens++;throw new Error('Unexpected output');}
 }};
 const command=parseArgv(corpus.rows[0]!.args),task=phase==='probe'?wantsFlacCopy(command,context):executeFlacCopy(command,context);
 const rejected=expect(task).rejects.toBe(reason);
 await ready;controller.abort(reason);await rejected;
 expect(opens).toBe(0);
 if(phase==='extradata')expect(remove.mock.calls.some(([event,listener])=>event==='abort'&&typeof listener==='function'&&listener.name==='forward')).toBe(true);
 if(late==='reject')fail(new Error('late provider failure'));else finish(input.subarray(0,4));
 await new Promise<void>(resolve=>setTimeout(resolve,0));remove.mockRestore();
});

for(const options of [
 ['-codec','copy'],
 ['-codec:a','copy'],
 ['-codec:a:0','copy'],
 ['-codec:0','copy'],
 ['-codec','pcm_s16le','-codec:a','copy'],
 ['-codec:a','pcm_s16le','-codec','copy'],
 ['-c','pcm_s16le','-codec:a','copy'],
 ['-codec','pcm_s16le','-c:a','copy'],
])it(`resolves codec aliases and ordered copy overrides: ${options.join(' ')}`,async()=>{
 const run=setup(),result=await run.ffmpeg.exec(['-i','/input.bin',...options,'-f','framecrc','/output.crc']);
 expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(0);
 expect(run.text()).toBe(corpus.rows[0]!.stdout);expect(run.commits).toBe(1);
});
for(const options of [
 ['-codec','copy','-codec:a','pcm_s16le'],
 ['-codec:a','copy','-codec','pcm_s16le'],
 ['-c:a','copy','-codec','pcm_s16le'],
])it(`rejects a later decoding override through codec aliases: ${options.join(' ')}`,async()=>{
 const run=setup(),result=await run.ffmpeg.exec(['-i','/input.bin',...options,'-f','framecrc','/output.crc']);
 expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/FLAC codec module is not configured/);expect(run.opens).toBe(0);
});

import {probeFlacInput} from '../../packages/avformat/src/flac-copy.js';
import {muxFlacFrameCrc} from '@edge-ffmpeg/containers';
it('retains the probed generation for implicit and explicit FLAC',async()=>{
 for(const explicit of [false,true]){
 const input=Buffer.from(corpus.input,'base64'),chunks:Uint8Array[]=[];let opens=0;
 const context:BackendContext={signal:new AbortController().signal,budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){const bytes=opens++===0?input:Buffer.from('changed generation');return {size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(bytes){chunks.push(bytes.slice());},async commit(){},async abort(){}};}}};
 const command=parseArgv([...(explicit?['-f','flac']:[]),...corpus.rows[0]!.args]),probe=await probeFlacInput(command,context);
 expect(probe?.explicit).toBe(explicit);await executeFlacCopy(command,context,probe!.handle);
 expect(opens).toBe(1);expect(Buffer.concat(chunks).toString()).toBe(corpus.rows[0]!.stdout);
 }
});
it('snapshots framecrc primitives before output writes can mutate callers',async()=>{
 const format={sampleRate:8000,channelLayout:'mono',extradata:new Uint8Array(34),streams:1};
 const options={maxWriteBytes:34,signal:new AbortController().signal,bitexact:true,maxPackets:0n};const chunks:Uint8Array[]=[];
 await muxFlacFrameCrc({async write(bytes){chunks.push(bytes.slice());format.sampleRate=1;format.channelLayout='changed';format.streams=64;options.maxWriteBytes=0;options.bitexact=false;options.maxPackets=1n;},async commit(){},async abort(){}},format,{async *[Symbol.asyncIterator](){throw Error('zero limit must not pull packets');}},options);
 const text=Buffer.concat(chunks).toString();expect(text).toContain('#sample_rate 0: 8000');expect(text).toContain('#channel_layout_name 0: mono');expect(text).not.toContain('#software');expect(text).not.toContain('#tb 1:');
});
for(const explicit of [false,true])it(`aborts stalled input open and observes late rejection (explicit=${explicit})`,async()=>{
 const controller=new AbortController(),reason=Error('cancel open');let fail!:(error:unknown)=>void;
 const pending=new Promise<never>((_,reject)=>{fail=reject;});
 const context:BackendContext={signal:controller.signal,budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{openRead(){return pending;},async openWrite(){throw Error('unexpected output');}}};
 const command=parseArgv([...(explicit?['-f','flac']:[]),...corpus.rows[0]!.args]);
 const task=probeFlacInput(command,context),rejected=expect(task).rejects.toBe(reason);controller.abort(reason);await rejected;fail(Error('late open failure'));await Promise.resolve();
});
it('retains the input generation through public backend dispatch',async()=>{
 const input=Buffer.from(corpus.input,'base64'),chunks:Uint8Array[]=[];let opens=0;
 const context:BackendContext={signal:new AbortController().signal,budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){const bytes=opens++===0?input:Buffer.from('changed generation');return {size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(bytes){chunks.push(bytes.slice());},async commit(){},async abort(){}};}}};
 await createMediaBackend().execute(parseArgv(corpus.rows[0]!.args),context);
 expect(opens).toBe(1);expect(Buffer.concat(chunks).toString()).toBe(corpus.rows[0]!.stdout);
});
it('snapshots codec policy before provider callbacks mutate options',async()=>{
 const input=Buffer.from(corpus.input,'base64'),command=parseArgv(corpus.rows[0]!.args);
 const codec=command.outputs[0]!.options.find(option=>option.name==='-c')!;
 const context:BackendContext={signal:new AbortController().signal,budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){codec.value='pcm_s16le';return {size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+length);}};},async openWrite(){return {async write(){},async commit(){},async abort(){}};}}};
 await expect(executeFlacCopy(command,context)).resolves.toEqual(['/output.crc']);
});
for(const phase of ['open','write'] as const)it(`detaches cancellation from stalled output ${phase} and cleans late handles`,async()=>{
 const input=Buffer.from(corpus.input,'base64'),controller=new AbortController(),reason=Error('cancel output');
 let started!:()=>void,finish!:()=>void,aborts=0;
 const ready=new Promise<void>(resolve=>{started=resolve;}),pending=new Promise<void>(resolve=>{finish=resolve;});
 const context:BackendContext={signal:controller.signal,budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+length);}};},async openWrite(){if(phase==='open'){started();await pending;}return {async write(){if(phase==='write'){started();await pending;}},async commit(){throw Error('must not publish');},async abort(){aborts++;}};}}};
 const task=executeFlacCopy(parseArgv(corpus.rows[0]!.args),context),rejected=expect(task).rejects.toBe(reason);
 await ready;controller.abort(reason);await rejected;finish();
 await new Promise<void>(resolve=>setTimeout(resolve,0));expect(aborts).toBeGreaterThan(0);
});
it('uses one captured read capability for demux and STREAMINFO',async()=>{
 const input=Buffer.from(corpus.input,'base64'),chunks:Uint8Array[]=[];
 const handle={size:BigInt(input.length),async readAt(at:bigint,length:number){
  handle.readAt=async()=>{throw Error('replaced read capability');};
  return input.subarray(Number(at),Number(at)+length);
 }};
 const context:BackendContext={signal:new AbortController().signal,budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){return handle;},async openWrite(){return {async write(bytes){chunks.push(bytes.slice());},async commit(){},async abort(){}};}}};
 await executeFlacCopy(parseArgv(corpus.rows[0]!.args),context);
 expect(Buffer.concat(chunks).toString()).toBe(corpus.rows[0]!.stdout);
});
it('snapshots public command policy before the implicit probe awaits',async()=>{
 const input=Buffer.from(corpus.input,'base64'),command=parseArgv(corpus.rows[0]!.args),chunks:Uint8Array[]=[];
 const context:BackendContext={signal:new AbortController().signal,budget:{maxBufferBytes:34,maxResidentBytes:1048576,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){
  command.outputs[0]!.options.find(option=>option.name==='-c')!.value='pcm_s16le';
  command.outputs[0]!.url='/changed.crc';
  return {size:BigInt(input.length),async readAt(at,length){return input.subarray(Number(at),Number(at)+length);}};
 },async openWrite(url){expect(url).toBe('/output.crc');return {async write(bytes){chunks.push(bytes.slice());},async commit(){},async abort(){}};}}};
 await expect(createMediaBackend().execute(command,context)).resolves.toEqual(['/output.crc']);
 expect(Buffer.concat(chunks).toString()).toBe(corpus.rows[0]!.stdout);
});
