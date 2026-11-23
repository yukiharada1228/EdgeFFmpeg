import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

interface Descriptor {channels:number;sampleRate:number;bitsPerSample:number;totalSamples:number;channelLayout:string;sampleFormat:string}
interface Frame {samples:number;pts:string|null;num:string|null;den:string|null;sampleFormat:string;channelLayout:string;channels:number;sampleRate:number;bytes:number;checksum:string}
interface Row {id:string;input:string;inputSha256:string;output:string|null;outputSha256:string|null;exitCode:number;variant:string;maxFrames:number|null;sampleCount?:number;descriptors:Descriptor[];decodedFrames:{samples:number;pts:number}[];packetEvidenceRowId?:string;packets?:{duration:number;pts:number;bytes:number;checksum:string}[]}
interface Result {ok:boolean;error:string|null;cancelReasonPreserved:boolean;metadata:Descriptor&{totalSamples:string;timeBase:{num:string;den:string};channelMask:string};frames:Frame[];totalBytes:number;size:number|null;sha256:string|null;owned:number;peak:number;preparedOwned:number;heldOwned:number;afterReleaseOwned:number|null;reservations:number;releases:number;decoderLive:number;maxDecoderLive:number;reads:number;maxRead:number;maxReturned:number;writes:number;maxWrite:number;multipartCreated:number;multipartLive:number;aborts:number;lateSettled:number;precommitChecks:number;lazy:boolean;completed:boolean;returned:boolean;thrown:boolean;stages:number}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

it('accepts Native source-format FLAC frames through real R2/workerd with bounded ownership and transactional failure cleanup',async()=>{
 const api=JSON.parse(readFileSync('.build/hermes-max/api/frames.json','utf8')) as {module:string;exports:Record<string,string>};
 expect(api.module).toBe('packages/avformat/src/flac-wave-frames.ts');expect(api.exports).toHaveProperty('decodeFlacAudioFrames');expect(api.exports).toHaveProperty('prepareFlacAudioFrames');
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-frames/cases.json','utf8')) as {wasmSha256:string;binarySha256:string;differences:unknown[];sourcePins:Record<string,string>;rows:Row[]};
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');expect(corpus.rows).toHaveLength(64);expect(corpus.differences).toEqual([]);
 for(const [path,digest] of Object.entries(corpus.sourcePins))expect(sha(readFileSync('upstream/ffmpeg/'+path)),path).toBe(digest);
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const rows=corpus.rows.filter(row=>row.variant==='raw');expect(rows.length).toBeGreaterThan(0);
 // Errors remain explicit scoped evidence, never an all-supported assertion.
 expect(rows.filter(row=>row.exitCode!==0).map(row=>({id:row.id,exitCode:row.exitCode}))).toEqual([]);
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-max-frames-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/'),name).toBe(false);expect(name.startsWith('node:'),name).toBe(false);}
 expect(Object.keys(bundle.metafile!.inputs)).toContain('packages/avformat/src/flac-wave-frames.ts');expect(Object.keys(bundle.metafile!.inputs)).toContain('packages/avcodec/src/flac/decoder.ts');
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(item=>item.path==='./edge-flac.wasm'&&item.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-frames-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 const sentinel=Buffer.from('previous-output'),sentinelSha=sha(sentinel),failures:unknown[]=[];
 const request=async(mode='normal',frames:number|null=null):Promise<Result>=>{
  const response=await mf.dispatchFetch('https://flac-max-frames.test/?mode='+mode+'&frames='+(frames??'all'));expect(response.status).toBe(200);return await response.json() as Result;
 };
 function clean(result:Result){expect(result.owned).toBe(0);expect(result.decoderLive).toBe(0);expect(result.maxDecoderLive).toBeLessThanOrEqual(1);expect(result.releases).toBe(result.reservations);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);expect(result.peak).toBeLessThanOrEqual(16912384);expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxReturned).toBeLessThanOrEqual(127);expect(result.maxWrite).toBeLessThanOrEqual(65536);}
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const row of rows){try{
   const input=Buffer.from(row.input,'base64'),expected=Buffer.from(row.output!,'base64');expect(sha(input),row.id).toBe(row.inputSha256);expect(sha(expected),row.id).toBe(row.outputSha256);
   await bucket.put('source/input.flac',input);await bucket.put('output/result.raw',sentinel);
   const result=await request('normal',row.maxFrames);expect(result.ok,row.id+': '+result.error).toBe(true);clean(result);expect(result.lazy).toBe(true);expect(result.reservations).toBe(1);expect(result.maxDecoderLive).toBe(1);expect(result.preparedOwned).toBeGreaterThanOrEqual(16777216);expect(result.sha256,row.id).toBe(row.outputSha256);expect(result.size).toBe(expected.length);expect(result.totalBytes).toBe(expected.length);expect(result.frames.reduce((sum,frame)=>sum+frame.samples,0)).toBe(row.sampleCount);expect(result.completed).toBe(true);expect(result.precommitChecks).toBeGreaterThan(0);
   const object=await bucket.get('output/result.raw');expect(Buffer.from(await object!.arrayBuffer()).equals(expected),row.id+' actual R2 bytes').toBe(true);
   const info=row.descriptors[0]!;expect(result.metadata).toMatchObject({channels:info.channels,sampleRate:info.sampleRate,bitsPerSample:info.bitsPerSample,totalSamples:String(info.totalSamples),channelLayout:info.channelLayout,sampleFormat:info.sampleFormat,timeBase:{num:'1',den:String(info.sampleRate)}});
   let position=0;for(const frame of result.frames){expect(frame).toMatchObject({pts:String(position),num:'1',den:String(info.sampleRate),sampleFormat:info.sampleFormat,channelLayout:info.channelLayout,channels:info.channels,sampleRate:info.sampleRate});expect(frame.bytes).toBe(frame.samples*info.channels*(info.bitsPerSample<=16?2:4));position+=frame.samples;}
   if(row.maxFrames!==0){const packetRow=corpus.rows.find(item=>item.id===row.packetEvidenceRowId);expect(packetRow,row.id).toBeDefined();expect(result.frames.map(frame=>({samples:frame.samples,pts:Number(frame.pts),bytes:frame.bytes,checksum:frame.checksum}))).toEqual(packetRow!.packets!.map(packet=>({samples:packet.duration,pts:packet.pts,bytes:packet.bytes,checksum:packet.checksum})));}
  }catch(error){failures.push({id:row.id,error:String(error)});}}
  const control=rows.find(row=>row.id==='24-2-ramp-5/raw/frames-all')!;
  await bucket.put('source/input.flac',Buffer.from(control.input,'base64'));
  for(const mode of ['eager','split','prepare-only','return','throw','held-abort','resource-abort','pending-read-abort','late-read-failure','reservation-budget','frame-budget','write-failure','cancel-write','late-write-failure']){try{
   await bucket.put('output/result.raw',sentinel);const result=await request(mode);clean(result);
   if(mode==='eager'||mode==='split'){expect(result.ok,mode+': '+result.error).toBe(true);expect(result.sha256).toBe(control.outputSha256);expect(result.size).toBe(Buffer.from(control.output!,'base64').length);if(mode==='split'){expect(result.frames.length).toBeGreaterThan(control.decodedFrames.length);expect(result.frames.every(frame=>frame.bytes<=256)).toBe(true);expect(result.maxRead).toBeLessThanOrEqual(256);let position=0;for(const frame of result.frames){expect(frame.pts).toBe(String(position));position+=frame.samples;}expect(position).toBe(control.sampleCount);}}
   else {expect(result.sha256,mode).toBe(sentinelSha);expect(result.size).toBe(sentinel.length);if(mode==='prepare-only'){expect(result.ok).toBe(true);expect(result.frames).toEqual([]);expect(result.multipartCreated).toBe(0);}else if(mode==='return'){expect(result.ok).toBe(true);expect(result.returned).toBe(true);expect(result.aborts).toBeGreaterThan(0);}else{expect(result.ok,mode).toBe(false);expect(result.error).toBeTruthy();if(mode==='reservation-budget')expect(result.reservations).toBe(0);if(['throw','held-abort','resource-abort','pending-read-abort','late-read-failure','cancel-write','late-write-failure'].includes(mode))expect(result.cancelReasonPreserved,mode+': '+result.error).toBe(true);if(mode==='held-abort'||mode==='resource-abort')expect(result.afterReleaseOwned).toBe(0);if(mode.includes('late-')||mode==='pending-read-abort')expect(result.lateSettled,mode).toBe(1);}}
  }catch(error){failures.push({mode,error:String(error)});}}
  expect(failures).toEqual([]);
 }finally{
  if(bucket){await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');const stages=(await bucket.list({prefix:'stage/'})).objects;for(const object of stages)await bucket.delete(object.key);expect(stages).toEqual([]);expect((await bucket.list()).objects).toEqual([]);}
  await mf.dispose();
 }
},120000);
