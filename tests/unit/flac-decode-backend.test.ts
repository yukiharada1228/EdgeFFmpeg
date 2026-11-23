import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {executeFlacDecode} from '../../packages/avformat/src/flac-decode.js';
import corpus from '../../compat/behavior-specs/flac-decode-cli/cases.json' with {type:'json'};
const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm'),module=new WebAssembly.Module(wasm);
function setup(input:string,options:{failWrite?:boolean;exists?:boolean;controller?:AbortController;resident?:number;buffer?:number}={}){
 const bytes=Buffer.from(input,'base64'),chunks:Uint8Array[]=[];let commits=0,aborts=0,opens=0,reads=0,maxRead=0,maxWrite=0;
 const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,{module,maxReadBytes:31})},budget:{maxResidentBytes:options.resident??33554432,maxBufferBytes:options.buffer??65536,maxPendingPackets:16,maxCpuTimeMs:10000},filesystem:{async outputExists(){return options.exists??false;},async openRead(){reads++;return {size:BigInt(bytes.length),async readAt(at,length){maxRead=Math.max(maxRead,length);return bytes.subarray(Number(at),Number(at)+Math.min(length,7));}};},async openWrite(){opens++;return {async write(data){maxWrite=Math.max(maxWrite,data.length);if(options.failWrite)throw Error('write failed');chunks.push(data.slice());options.controller?.abort(Error('cancel output'));},async commit(){commits++;},async abort(){aborts++;}};}}});
 return {ffmpeg,bytes:()=>Buffer.concat(chunks),get commits(){return commits;},get aborts(){return aborts;},get opens(){return opens;},get reads(){return reads;},get maxRead(){return maxRead;},get maxWrite(){return maxWrite;}};
}
it('pins the trusted canonical module',()=>{expect(createHash('sha256').update(wasm).digest('hex')).toBe(corpus.wasmSha256);expect(corpus.wasmSha256).toBe('d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f');});
for(const row of corpus.rows)it(`matches Native ${row.id}`,async()=>{const run=setup(row.input),result=await run.ffmpeg.exec(row.args);expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(row.exitCode);expect(run.bytes().toString('base64')).toBe(row.output);expect(run.commits).toBe(1);expect(run.reads).toBe(1);expect(run.maxRead).toBeLessThanOrEqual(31);expect(run.maxWrite).toBeLessThanOrEqual(65536);});
it('rejects unsupported semantics before output creation',async()=>{for(const options of [['-af','unsupported_filter'],['-ss','-1'],['-map','0:1'],['-an'],['-metadata','title=x']]){const row=corpus.rows.find(row=>row.id==='16-2-extremes-5/s16le')!,run=setup(row.input),result=await run.ffmpeg.exec([...row.args.slice(0,-1),...options,'/out']);expect(result.exitCode).not.toBe(0);expect(run.opens).toBe(0);}});
it('honors overwrite and aborts failures without publication',async()=>{const row=corpus.rows.find(row=>row.id==='16-2-extremes-5/s16le')!;for(const options of [{failWrite:true},{controller:new AbortController()}]){const run=setup(row.input,options),result=await run.ffmpeg.exec(row.args,'controller' in options?{signal:options.controller.signal}:{});expect(result.exitCode).not.toBe(0);expect(run.commits).toBe(0);expect(run.aborts).toBeGreaterThan(0);}const denied=setup(row.input,{exists:true});expect((await denied.ffmpeg.exec(['-n',...row.args])).diagnostics[0]?.code).toBe('output-exists');expect(denied.opens).toBe(0);const allowed=setup(row.input,{exists:true});expect((await allowed.ffmpeg.exec(['-y',...row.args])).exitCode).toBe(0);});
it('enforces combined Wasm and Core reservations',async()=>{const row=corpus.rows.find(row=>row.id==='16-2-extremes-5/s16le')!,run=setup(row.input,{resident:16777216});expect((await run.ffmpeg.exec(row.args)).exitCode).not.toBe(0);expect(run.opens).toBe(0);});
it('streams conversion below a decoded frame size',async()=>{const row=corpus.rows.find(row=>row.id==='32-2-extremes-5/f64le')!,run=setup(row.input,{buffer:128});expect((await run.ffmpeg.exec(row.args)).diagnostics).toEqual([]);expect(run.bytes().toString('base64')).toBe(row.output);expect(run.maxWrite).toBeLessThanOrEqual(128);});
it('rejects unrepresentable framecrc frames rather than changing packet boundaries',async()=>{const row=corpus.rows.find(row=>row.id==='32-2-extremes-5/framecrc')!,run=setup(row.input,{buffer:128});expect((await run.ffmpeg.exec(row.args)).exitCode).not.toBe(0);expect(run.commits).toBe(0);});

import {ResourceContext} from '@edge-ffmpeg/core';
import {parseArgv} from '@edge-ffmpeg/cli';
import {vi} from 'vitest';
it('releases Wasm, held frames and Core scratch after completion, output failure and cancellation',async()=>{
 const original=ResourceContext.prototype.reserveExternalMemory,contexts=new Set<ResourceContext>();
 const spy=vi.spyOn(ResourceContext.prototype,'reserveExternalMemory').mockImplementation(function(this:ResourceContext,bytes){contexts.add(this);return original.call(this,bytes);});
 try{const row=corpus.rows.find(row=>row.id==='32-2-extremes-5/f64le')!;for(const kind of ['success','failure','cancel'] as const){const controller=new AbortController(),run=setup(row.input,kind==='failure'?{failWrite:true}:kind==='cancel'?{controller}:{});await run.ffmpeg.exec(row.args,{signal:controller.signal});await new Promise<void>(resolve=>setTimeout(resolve,0));for(const resources of contexts)expect(resources.allocatedBytes).toBe(0);}}finally{spy.mockRestore();}
});
it('uses an already-probed immutable reader generation without reopening',async()=>{
 const row=corpus.rows.find(row=>row.id==='24-2-extremes-5/s32le')!,bytes=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];
 await executeFlacDecode(parseArgv(row.args),{signal:new AbortController().signal,budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){throw Error('must not reopen');},async openWrite(){return {async write(chunk){chunks.push(chunk.slice());},async commit(){},async abort(){}};}}},{module},{size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}});
 expect(Buffer.concat(chunks).toString('base64')).toBe(row.output);
});
it('decodes unknown finite PCM lengths and rejects signed timestamp offsets',async()=>{
 const row=corpus.rows.find(row=>row.id==='24-2-extremes-5/s32le')!,bytes=Buffer.from(row.input,'base64');bytes.writeBigUInt64BE(bytes.readBigUInt64BE(18)&~((1n<<36n)-1n),18);
 const run=setup(bytes.toString('base64'));expect((await run.ffmpeg.exec(row.args)).diagnostics).toEqual([]);expect(run.bytes().toString('base64')).toBe(row.output);expect(run.commits).toBe(1);
 for(const option of ['-itsoffset','-ss']){const run=setup(row.input);expect((await run.ffmpeg.exec([option,'-1',...row.args])).exitCode).not.toBe(0);expect(run.opens).toBe(0);}
});

import metadataCorpus from '../../compat/behavior-specs/flac-demux/metadata.json' with {type:'json'};
it('rejects tags and selected attached pictures instead of silently dropping them',async()=>{
 const tagged=metadataCorpus.rows.find(row=>'tags' in row.native&&Object.keys(row.native.tags).some(key=>key.toLowerCase()!=='encoder'));
 if(!tagged)throw Error('Missing metadata fixture');
 const run=setup(tagged.input),result=await run.ffmpeg.exec(['-i','/in.flac','-map','0:a','-f','wav','/out']);expect(result.diagnostics[0]?.message).toMatch(/tags|chapters/);expect(run.opens).toBe(0);
 const pictured=metadataCorpus.rows.find(row=>'pictures' in row.native&&row.native.pictures.length>0);if(!pictured)throw Error('Missing picture fixture');
 const selected=setup(pictured.input),pictureResult=await selected.ffmpeg.exec(['-i','/in.flac','-map_metadata','-1','-f','framecrc','/out']);expect(pictureResult.diagnostics[0]?.message).toMatch(/attached pictures|chapter/);expect(selected.opens).toBe(0);
 for(const map of ['0','0?']){const selected=setup(pictured.input),result=await selected.ffmpeg.exec(['-i','/in.flac','-map',map,'-map_metadata','-1','-f','framecrc','/out']);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/attached pictures/);expect(selected.opens).toBe(0);expect(selected.commits).toBe(0);}
});
it('captures trusted configuration before awaits and enforces decoder frame bytes before output',async()=>{
 const row=corpus.rows.find(row=>row.id==='32-2-extremes-5/s32le')!,bytes=Buffer.from(row.input,'base64');
 for(const bound of [1,4194304]){let opens=0;const chunks:Uint8Array[]=[];const configuration={module,maxFrameBytes:bound};
 const ffmpeg=new FFmpeg({backend:{execute:(command,context)=>executeFlacDecode(command,context,configuration)},budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){configuration.maxFrameBytes=1;return {size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}};},async openWrite(){opens++;return {async write(data){chunks.push(data.slice());},async commit(){},async abort(){}};}}});
 const result=await ffmpeg.exec(row.args);if(bound===1){expect(result.exitCode).not.toBe(0);expect(opens).toBe(0);}else{expect(result.diagnostics).toEqual([]);expect(Buffer.concat(chunks).toString('base64')).toBe(row.output);}
 }
});
