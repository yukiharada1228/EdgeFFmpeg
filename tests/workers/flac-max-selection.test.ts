import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
interface NativeRow {kind:'audio'|'pictured';maps:string[];audio:boolean;video:boolean;exitCode:number;selected:number[]}
interface DecodeRow {id:string;input:string;inputSha256:string;bits:number;channels:number;samples:number;pcmSha256:string;frames:{samples:number;samplePosition:string}[]}
interface AdvancedRow {id:string;sourceId:string;input:string;inputSha256:string;args:string[];output:string;outputSha256:string;maps:string[];exitCode:number;selectedStreamIds:number[];descriptors:{streamId:number;mediaType:string;metadata:Record<string,string>;nativeDescription:string}[]}
interface Result {selection?:{streamIds:number[];pictureStreamIds:number[];automatic:boolean};error?:string;code?:string;cancelReasonPreserved:boolean;frames:DecodeRow['frames'];samples:number;totalBytes:number;size:number|null;sha256:string|null;reads:number;maxRead:number;maxReturned:number;writes:number;maxWrite:number;opens:number;aborts:number;commits:number;owned:number;memoryBytes:number;peak:number;reservations:number;releases:number;multipartLive:number;multipartCreated:number;stages:number}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const options=(maps:string[],audio=true,video=true)=>({maps,audio,video,defaults:{audio:true,picture:'first'}});
it('preserves Native144 selection and actual R2/Wasm PCM with bounded reads, Core ownership and atomic failure cleanup',async()=>{
 const native=JSON.parse(readFileSync('compat/behavior-specs/flac-selection/cases.json','utf8')) as {binarySha256:string;rows:NativeRow[]};expect(native.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');expect(native.rows).toHaveLength(144);
 const decode=JSON.parse(readFileSync('compat/behavior-specs/flac-decode-workers/cases.json','utf8')) as {wasmSha256:string;rows:DecodeRow[]};const control=decode.rows.find(row=>row.id==='16-1-zero-0');expect(control).toBeDefined();const row=control!,input=Buffer.from(row.input,'base64'),wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(input)).toBe(row.inputSha256);expect(sha(wasm)).toBe(decode.wasmSha256);
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-max-selection-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-selection-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 const request=async(body:object)=>{const response=await mf.dispatchFetch('https://selection.test/',{method:'POST',body:JSON.stringify(body)});expect(response.status).toBe(200);return await response.json() as Result;};
 const clean=(actual:Result)=>{expect(actual.owned).toBe(0);expect(actual.memoryBytes).toBe(0);expect(actual.stages).toBe(0);expect(actual.multipartLive).toBe(0);expect(actual.reservations).toBe(actual.releases);expect(actual.peak).toBeLessThanOrEqual(25165824);expect(actual.maxRead).toBeLessThanOrEqual(4096);expect(actual.maxReturned).toBeLessThanOrEqual(19);expect(actual.maxWrite).toBeLessThanOrEqual(65536);};
 try{await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');await bucket.put('source/input.flac',input);
  for(const [index,row] of native.rows.entries()){
   const actual=await request({selectionOnly:true,options:options(row.maps,row.audio,row.video),identities:{audioStreamId:0,pictureStreamIds:row.kind==='pictured'?[1]:[]}});
   if(row.exitCode===0){expect(actual.error,'Native144 '+index).toBeUndefined();expect(actual.selection?.streamIds,'Native144 '+index).toEqual(row.selected);}else{expect(actual.error,'Native144 '+index).toBeDefined();expect(actual.code).toBe('invalid-arguments');}expect(actual.opens).toBe(0);clean(actual);
  }
  for(const maps of [[],['0:a'],['0:2?'],['0','-0:v'],['-0:a?']]){
   await bucket.delete('output/result.pcm');const actual=await request({options:options(maps),identities:{audioStreamId:0,pictureStreamIds:[]}});expect(actual.error,JSON.stringify(maps)).toBeUndefined();expect(actual.sha256).toBe(row.pcmSha256);expect(actual.size).toBe(row.samples*row.channels*(row.bits<=16?2:4));expect(actual.totalBytes).toBe(actual.size);expect(actual.samples).toBe(row.samples);expect(actual.frames).toEqual(row.frames);expect(actual.commits).toBe(1);expect(actual.reads).toBeGreaterThan(0);expect(actual.reservations).toBe(1);clean(actual);
  }
  const sentinel=Buffer.from('previous selection output');for(const mode of ['cancel-write','write-failure','read-abort','output-budget','held-read-abort']){
   await bucket.put('output/result.pcm',sentinel);const actual=await request({mode,options:options(['0:a']),identities:{audioStreamId:0,pictureStreamIds:[]}});expect(actual.error,mode).toBeDefined();expect(actual.sha256,mode).toBe(sha(sentinel));expect(actual.size).toBe(sentinel.length);expect(actual.commits).toBe(0);if(mode.includes('abort')||mode==='cancel-write')expect(actual.cancelReasonPreserved,mode).toBe(true);if(actual.opens)expect(actual.aborts).toBe(1);clean(actual);
  }
  const picture=await request({options:options(['0:v']),identities:{audioStreamId:0,pictureStreamIds:[1]}});expect(picture.code).toBe('unsupported-command');expect(picture.selection?.streamIds).toEqual([1]);expect(picture.opens).toBe(0);expect(picture.reads).toBe(0);clean(picture);
  const snapshot=await request({selectionOnly:true,mutateAfterSnapshot:true,options:options(['0:a','0:a']),identities:{audioStreamId:0,pictureStreamIds:[1]}});expect(snapshot.error).toBeUndefined();expect(snapshot.selection?.streamIds).toEqual([0,0]);clean(snapshot);
  for(const maps of [Array.from({length:65},()=> '0:a'),['0:a:'],['1:a?']]){const actual=await request({options:options(maps),identities:{audioStreamId:0,pictureStreamIds:[]}});expect(actual.error).toBeDefined();expect(actual.reads).toBe(0);expect(actual.opens).toBe(0);clean(actual);}
  for(const maps of [['0:m:title?'],['0:a:u']]){const actual=await request({options:options(maps),identities:{audioStreamId:0,pictureStreamIds:[]}});expect(actual.code).toBe('unsupported-command');expect(actual.reads).toBe(0);expect(actual.opens).toBe(0);clean(actual);}
  const advanced=JSON.parse(readFileSync('compat/behavior-specs/flac-max-selection/cases.json','utf8')) as {binarySha256:string;wasmSha256:string;rows:AdvancedRow[]};expect(advanced.binarySha256).toBe(native.binarySha256);expect(advanced.wasmSha256).toBe(sha(wasm));expect(advanced.rows).toHaveLength(60);
  const pcm=JSON.parse(readFileSync('compat/behavior-specs/flac-decode-cli/cases.json','utf8')) as {rows:{id:string;output:string;outputSha256:string}[]},expected=pcm.rows.find(row=>row.id==='16-2-extremes-5/s16le')!;expect(sha(Buffer.from(expected.output,'base64'))).toBe(expected.outputSha256);
  const differences:{id:string;error:string}[]=[];
  for(const advancedRow of advanced.rows){try{
   const input=Buffer.from(advancedRow.input,'base64');expect(sha(input),advancedRow.id).toBe(advancedRow.inputSha256);await bucket.put('source/input.flac',input);await bucket.delete('output/result.pcm');
   const identities={audioStreamId:0,pictureStreamIds:advancedRow.descriptors.filter(value=>value.mediaType==='video').map(value=>value.streamId),streamDescriptors:advancedRow.descriptors.map(value=>({streamId:value.streamId,tags:value.metadata,dispositions:value.mediaType==='video'?['attached_pic']:[]}))};
   const selected=await request({selectionOnly:true,options:options(advancedRow.maps),identities});clean(selected);
   if(advancedRow.exitCode!==0){expect(selected.code,advancedRow.id).toBe('invalid-arguments');expect(selected.opens).toBe(0);continue;}
   expect(selected.error,advancedRow.id).toBeUndefined();expect(selected.selection?.streamIds,advancedRow.id).toEqual(advancedRow.selectedStreamIds);
   const actual=await request({options:options(advancedRow.maps),identities});clean(actual);
   if(advancedRow.selectedStreamIds.some(id=>id!==0)){expect(actual.code).toBe('unsupported-command');expect(actual.opens).toBe(0);expect(actual.sha256).toBeNull();}
   else{expect(actual.error,advancedRow.id).toBeUndefined();expect(actual.sha256,advancedRow.id).toBe(expected.outputSha256);expect(actual.size).toBe(Buffer.from(expected.output,'base64').length);expect(actual.frames.length).toBeGreaterThan(0);let position=0;for(const frame of actual.frames){expect(frame.samplePosition).toBe(String(position));position+=frame.samples;}expect(actual.samples).toBe(position);expect(actual.totalBytes).toBe(position*4);expect(actual.commits).toBe(1);}
  }catch(error){differences.push({id:advancedRow.id,error:String(error)});}}
  expect(differences,'Scoped Native advanced selector differences; never broaden unsupported fallback').toEqual([]);
  const publicDifferences:{id:string;error:string}[]=[];
  let publicParity=0,publicPictureGaps=0;
  for(const nativeRow of advanced.rows){try{
   await bucket.put('source/input.flac',Buffer.from(nativeRow.input,'base64'));await bucket.put('output/result.pcm',sentinel);
   // Packet copy has no scalar/SIMD arithmetic; preserve the Native command options.
   const argv=['-y',...nativeRow.args.map(value=>value==='/in.flac'?'/input/input.flac':value==='/out'?'/output/result.pcm':value)];
   const response=await mf.dispatchFetch('https://selection.test/',{method:'POST',body:JSON.stringify({argv})});expect(response.status).toBe(200);
   const actual=await response.json() as {exitCode:number;diagnostics:{code:string;message:string}[];outputs:string[];sha256:string;size:number;reads:number;maxRead:number;maxReturned:number;maxWrite:number;opens:number;commits:number;multipartLive:number;stages:number};
   expect(actual.reads,nativeRow.id).toBeGreaterThan(0);expect(actual.maxRead,nativeRow.id).toBeLessThanOrEqual(4096);expect(actual.maxReturned).toBeLessThanOrEqual(19);expect(actual.maxWrite).toBeLessThanOrEqual(65536);expect(actual.multipartLive).toBe(0);expect(actual.stages).toBe(0);
   if(nativeRow.exitCode===0&&nativeRow.selectedStreamIds.some(id=>id!==0)){
    expect(actual.exitCode,nativeRow.id).not.toBe(0);expect(actual.diagnostics.at(-1)?.code,nativeRow.id).toBe('unsupported-command');expect(actual.diagnostics.at(-1)?.message,nativeRow.id).toMatch(/picture/i);publicPictureGaps++;
   }else{
    expect(actual.exitCode,nativeRow.id+JSON.stringify(actual.diagnostics)).toBe(nativeRow.exitCode);publicParity++;
    if(nativeRow.exitCode===0){expect(sha(Buffer.from(nativeRow.output,'base64'))).toBe(nativeRow.outputSha256);expect(actual.sha256,nativeRow.id).toBe(nativeRow.outputSha256);expect(actual.size).toBe(Buffer.from(nativeRow.output,'base64').length);expect(actual.outputs).toEqual(['/output/result.pcm']);expect(actual.commits).toBe(1);continue;}
    expect(actual.diagnostics.at(-1)?.code,nativeRow.id).toBe('invalid-arguments');
   }
   expect(actual.opens,nativeRow.id).toBe(0);expect(actual.commits).toBe(0);expect(actual.outputs).toEqual([]);expect(actual.sha256,nativeRow.id).toBe(sha(sentinel));expect(actual.size).toBe(sentinel.length);
  }catch(error){publicDifferences.push({id:nativeRow.id,error:String(error)});}}
  expect(publicDifferences,'Public Workers selection differences; picture mux gaps are explicit, not parity').toEqual([]);
  expect(publicParity+publicPictureGaps).toBe(advanced.rows.length);expect(publicPictureGaps).toBeGreaterThan(0);
 }finally{if(bucket){await bucket.delete('source/input.flac');await bucket.delete('output/result.pcm');expect((await bucket.list({prefix:'stage/'})).objects).toEqual([]);expect((await bucket.list()).objects).toEqual([]);}await mf.dispose();}
},60000);

it('requires the independently generated advanced selection API and Native evidence before claiming advanced acceptance',()=>{
 // Required artifacts: absence is an explicit failure, never an optional skip or a fabricated oracle.
 const api=JSON.parse(readFileSync('.build/hermes-max/api/selection.json','utf8')) as {module:string;exports:string[]};
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-selection/cases.json','utf8')) as {status:string;limits:{sequential:boolean;nativeCalls:number}};
 expect(api.module).toBe('packages/avformat/src/flac-selection.ts');expect(api.exports).toContain('selectFlacStreams');expect(api.exports).toContain('FlacStreamDescriptor');expect(corpus.status).toBe('independent-native-evidence-not-production-conformance');expect(corpus.limits.sequential).toBe(true);expect(corpus.limits.nativeCalls).toBeLessThanOrEqual(64);
});
