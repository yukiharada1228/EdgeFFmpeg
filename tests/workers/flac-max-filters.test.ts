import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

interface Packet {streamId:number;dts:number;pts:number;duration:number;bytes:number;checksum:string}
interface PublicResult {exitCode:number;diagnostics:{code:string;message:string}[];outputs:string[];sha256:string|null;size:number|null;reads:number;maxRead:number;writes:number;maxWrite:number;opens:number;aborts:number;stages:number}
interface Row {id:string;input:string;inputSha256:string;args:string[];exitCode:number;output:string;outputSha256:string;filter:string;grammarProfile:string;sampleCount?:number;packets?:Packet[];outputSampleRate?:number;descriptors:{totalSamples:number;sampleRate:number;channels:number}[]}
interface Result {error:string|null;cancelReasonPreserved:boolean;committed:boolean;plan:{samples:string;outputRate:number;sampleFormat:string;encoderSampleFormat:string;requiresScalarRounding:boolean}|null;sha256:string;storedSha256:string|null;storedSize:number|null;sampleCount:number;totalBytes:number;frames:{samples:number;pts:string|null;timeBase:{num:string;den:string}|null;sampleRate:number;sampleFormat:string;owned:number}[];owned:number;peak:number;reservations:number;releases:number;reads:number;maxRead:number;shortReads:number;writes:number;maxWrite:number;sourceFrames:number;sourceReleased:number;sourceReturns:number;memoryBytes:number;lateSettled:boolean;multipartLive:number;multipartCreated:number;multipartAborted:number;stages:number}
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
// FFmpeg framecrc uses av_adler32_update with initial state zero.
function checksum(bytes:Uint8Array):string {let low=0,high=0;for(const byte of bytes){low=(low+byte)%65521;high=(high+low)%65521;}return '0x'+((high*65536+low)>>>0).toString(16).padStart(8,'0');}

it('runs finite FLAC filters on actual local R2/workerd with exact Native PCM, frame PTS and transactional cleanup',async()=>{
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-filters/cases.json','utf8')) as {binarySha256:string;wasmSha256:string;rows:Row[]};
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');expect(corpus.rows).toHaveLength(64);
 const api=JSON.parse(readFileSync('tests/fixtures/hermes-max/api/filters.json','utf8')) as {module:string};expect(api.module).toBe('packages/avformat/src/flac-wave-filters.ts');
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-max-filters-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);expect(name.includes('runtime-node')).toBe(false);}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-filters-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;const failures:{id:string;error:string}[]=[];
 const request=async(filter:string,mode='normal')=>{const response=await mf.dispatchFetch('https://filters.test/?codec=pcm_s32le&mode='+mode+'&filter='+encodeURIComponent(filter));return {status:response.status,result:await response.json() as Result};};
 const clean=(result:Result)=>{expect(result.owned).toBe(0);expect(result.memoryBytes).toBe(0);expect(result.reservations).toBe(result.releases);expect(result.sourceReleased).toBe(result.sourceFrames);expect(result.stages).toBe(0);expect(result.multipartLive).toBe(0);expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxWrite).toBeLessThanOrEqual(65536);};
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  const publicRequest=async(args:string[],mode='normal')=>{
   const response=await mf.dispatchFetch('https://filters.test/public?mode='+mode+'&args='+encodeURIComponent(JSON.stringify(args)));
   expect(response.status).toBe(200);return await response.json() as PublicResult;
  };
  const publicArgs=(row:Row)=>['-y','-cpuflags','0',...row.args.filter((_arg,index,args)=>args[index-1]!=='-fs'&&args[index]!=='-fs').map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg)];
  const publicSentinel=Buffer.from('previous-public-filter-output');
  for(const row of corpus.rows){try{
   expect(sha(Buffer.from(row.input,'base64'))).toBe(row.inputSha256);await bucket.put('source/input.flac',Buffer.from(row.input,'base64'));await bucket.put('output/result.raw',publicSentinel);
   const result=await publicRequest(publicArgs(row));
   if(row.grammarProfile==='invalid-native-grammar'){
    expect(result.exitCode).not.toBe(0);expect(result.outputs).toEqual([]);expect(result.opens).toBe(0);expect(result.sha256).toBe(sha(publicSentinel));
   }else{
    expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(result.outputs).toEqual(['/output/result.raw']);
    const stored=await bucket.get('output/result.raw');expect(stored).not.toBeNull();const bytes=new Uint8Array(await stored!.arrayBuffer());expect(result.sha256).toBe(sha(bytes));expect(result.size).toBe(bytes.length);expect(result.sha256).toBe(row.outputSha256);expect(Buffer.from(bytes)).toEqual(Buffer.from(row.output,'base64'));
    if(row.id.endsWith('/pcm')){
     expect(sha(Buffer.from(row.output,'base64'))).toBe(row.outputSha256);expect(result.sha256).toBe(row.outputSha256);expect(Buffer.from(bytes)).toEqual(Buffer.from(row.output,'base64'));
    }else{
     const packets=new TextDecoder().decode(bytes).split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const parts=line.split(',').map(part=>part.trim());return {streamId:Number(parts[0]),dts:Number(parts[1]),pts:Number(parts[2]),duration:Number(parts[3]),bytes:Number(parts[4]),checksum:parts[5]};});expect(packets).toEqual(row.packets);
    }
    expect(result.reads).toBeGreaterThan(0);expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxWrite).toBeLessThanOrEqual(65536);
   }
   expect(result.stages).toBe(0);
  }catch(error){failures.push({id:'public/'+row.id,error:String(error)});}}
  const publicSource=corpus.rows.find(row=>row.id==='asetnsamples-64-unpadded/pcm')!;
  await bucket.put('source/input.flac',Buffer.from(publicSource.input,'base64'));
  for(const mode of ['cancel-write','write-failure','output-budget']){try{
   await bucket.put('output/result.raw',publicSentinel);const result=await publicRequest(publicArgs(publicSource),mode);
   expect(result.exitCode).not.toBe(0);expect(result.outputs).toEqual([]);expect(result.sha256).toBe(sha(publicSentinel));expect(result.size).toBe(publicSentinel.length);expect(result.aborts).toBeGreaterThan(0);expect(result.stages).toBe(0);
  }catch(error){failures.push({id:'public/'+mode,error:String(error)});}}
  const pcmRows=corpus.rows.filter(row=>row.id.endsWith('/pcm')&&row.grammarProfile==='supported');
  expect(pcmRows.length).toBeGreaterThan(20);
  for(const row of pcmRows){try{
   const input=Buffer.from(row.input,'base64');expect(sha(input)).toBe(row.inputSha256);await bucket.put('source/input.flac',input);await bucket.delete('output/result.raw');
   const {status,result}=await request(row.filter);expect(status,row.id+': '+result.error).toBe(200);expect(result.error).toBeNull();expect(result.committed).toBe(true);
   const native=Buffer.from(row.output,'base64');expect(sha(native)).toBe(row.outputSha256);expect(result.sha256).toBe(row.outputSha256);expect(result.storedSha256).toBe(row.outputSha256);expect(result.storedSize).toBe(native.length);expect(result.totalBytes).toBe(native.length);expect(result.sampleCount).toBe(row.sampleCount);
   const stored=await bucket.get('output/result.raw');expect(stored).not.toBeNull();const bytes=new Uint8Array(await stored!.arrayBuffer());expect(Buffer.from(bytes)).toEqual(native);
   const timing=corpus.rows.find(other=>other.id===row.id.replace('/pcm','/framecrc'))!;expect(timing.exitCode).toBe(0);expect(result.plan!.samples).toBe(String(row.sampleCount));expect(result.plan!.outputRate).toBe(timing.outputSampleRate);expect(result.plan!.encoderSampleFormat).toBe('s32');
   expect(result.frames.map(frame=>({pts:Number(frame.pts),duration:frame.samples}))).toEqual(timing.packets!.map(packet=>({pts:packet.pts,duration:packet.duration})));
   let offset=0;for(const [index,frame] of result.frames.entries()){
    expect(frame.sampleRate).toBe(timing.outputSampleRate);expect(frame.timeBase).toEqual({num:'1',den:String(timing.outputSampleRate)});expect(frame.owned).toBeGreaterThan(16777216);
    const packet=timing.packets![index]!,length=frame.samples*row.descriptors[0]!.channels*4;expect(length).toBe(packet.bytes);expect(checksum(bytes.subarray(offset,offset+length))).toBe(packet.checksum);offset+=length;
   }
   expect(offset).toBe(bytes.length);expect(result.shortReads).toBeGreaterThan(0);expect(result.reads).toBeGreaterThan(0);clean(result);
  }catch(error){failures.push({id:row.id,error:String(error)});}}
  const source=pcmRows.find(row=>row.id==='anull-16-ramp/pcm')!;await bucket.put('source/input.flac',Buffer.from(source.input,'base64'));
  const sentinel=Buffer.from('previous-filter-output');
  for(const row of corpus.rows.filter(row=>row.grammarProfile==='invalid-native-grammar')){try{
   expect(row.exitCode).not.toBe(0);await bucket.put('output/result.raw',sentinel);const {status,result}=await request(row.filter);expect(status).toBe(422);expect(result.committed).toBe(false);expect(result.error).not.toBeNull();expect(result.storedSha256).toBe(sha(sentinel));expect(result.reads).toBe(0);expect(result.multipartCreated).toBe(0);clean(result);
  }catch(error){failures.push({id:row.id,error:String(error)});}}
  for(const mode of ['cancel-write','write-failure','held-abort','core-abort','pending-reject','pending-resolve','frame-budget','resident-budget','early-return']){try{
   await bucket.put('output/result.raw',sentinel);const {status,result}=await request('volume=0.5:precision=fixed,asetnsamples=n=64:p=0',mode);
   expect(status).toBe(mode==='early-return'?200:422);expect(result.committed).toBe(false);expect(result.storedSha256).toBe(sha(sentinel));expect(result.storedSize).toBe(sentinel.length);expect(result.multipartCreated).toBe(1);expect(result.multipartAborted).toBe(1);
   if(['cancel-write','held-abort','core-abort','pending-reject','pending-resolve'].includes(mode))expect(result.cancelReasonPreserved).toBe(true);
   if(mode.startsWith('pending-'))expect(result.lateSettled).toBe(true);else if(mode==='frame-budget'||mode==='resident-budget'){expect(result.sourceFrames).toBe(0);expect(result.sourceReturns).toBe(0);}else expect(result.sourceReturns).toBeGreaterThan(0);
   if(mode==='write-failure')expect(result.writes).toBe(2);if(mode==='resident-budget')expect(result.error).toContain('budget');if(mode==='frame-budget')expect(result.error).toMatch(/oversized|allocation|limit/i);clean(result);
  }catch(error){failures.push({id:mode,error:String(error)});}}
  expect(failures).toEqual([]);
 }finally{
  if(bucket){await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');const stages=(await bucket.list({prefix:'filters-stage/'})).objects;for(const stage of stages)await bucket.delete(stage.key);expect(stages).toEqual([]);expect((await bucket.list()).objects).toEqual([]);}
  await mf.dispose();
 }
},120000);
