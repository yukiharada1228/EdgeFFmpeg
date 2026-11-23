import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {MediaCheckpointStatus} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
type Run={outcome:string;units:number;status:MediaCheckpointStatus|null};
type Final={ok:boolean;existing?:boolean;bytes?:string;outputChunks?:number;opens:number;stages:number;uploads:number;live:number;error?:string;range?:boolean;conflict?:{expected:{bytes:string;sha256:string|null};actual:{bytes:string;sha256:string|null}}|null;uncertain?:boolean;recovered?:boolean;afterRecovery?:number};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
// Host-side mirror of the fixture cases and the equivalent Native commands.
const cases=[
 {name:'s16-pad',raw:'s16le',planar:'s16p',codec:'pcm_s16le',channels:2,width:2,pad:1,bitexact:false},
 {name:'u8-odd',raw:'u8',planar:'u8p',codec:'pcm_u8',channels:1,width:1,pad:0,bitexact:true},
 {name:'f32-fact',raw:'f32le',planar:'fltp',codec:'pcm_f32le',channels:2,width:4,pad:1,bitexact:false},
] as const;
function input(spec:(typeof cases)[number],samples:number):Buffer{
 const bytes=Buffer.alloc(samples*spec.channels*spec.width);
 for(let i=0;i<samples;i++)for(let c=0;c<spec.channels;c++){const at=(i*spec.channels+c)*spec.width;
  if(spec.width===1)bytes.writeUInt8(i===3?255:i===4?0:(i*53+c*101+7)&255,at);
  else if(spec.width===2)bytes.writeInt16LE(i===3?32767:i===4?-32768:((i*7919+c*104729)%65536)-32768,at);
  else bytes.writeFloatLE(i===3?1:i===4?-1:Math.sin(i*0.37+c)*0.75,at);}
 return bytes;
}
it('checkpoints an R2-backed FIFO into a WAV mux across fresh runtimes and publishes Native-identical WAV through header patches, no-clobber verification and commit races',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-wav-mux-checkpoint-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(sha(readFileSync(binary))).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 const bundle=await build({entryPoints:[root+'/wav-mux-checkpoint-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'wav-mux-checkpoint-test',modules:[{type:'ESModule',path:root+'/wav-mux-checkpoint-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),durableObjects:{CHECKPOINTS:{className:'MediaCheckpointCoordinator',useSQLite:true}},r2Buckets:['MEDIA_BUCKET']}));let mf=start();
 const restart=async()=>{await mf.dispose();mf=start();await mf.ready;return mf.getR2Bucket('MEDIA_BUCKET');};
 const samples=23;
 try{
  await mf.ready;let bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  const natives=new Map<string,Buffer>();
  for(const spec of cases){
   const bytes=input(spec,samples),fingerprint=sha(bytes),inputPath=join(directory,spec.name+'.raw');writeFileSync(inputPath,bytes);
   const etag=(await bucket.put('inputs/'+spec.name+'.raw',bytes,{customMetadata:{edgeInputSha256:fingerprint}}))!.etag,query=(extra:string)=>'?case='+spec.name+'&etag='+encodeURIComponent(etag)+'&fingerprint='+fingerprint+extra;
   const get=async<T>(path:string,extra=''):Promise<T>=>{const response=await mf.dispatchFetch('https://wav.test/'+path+query(extra)),value=await response.json() as T;expect(response.status,JSON.stringify(value)).toBe(200);return value;};
   const expire=async()=>{const lease=(await get<MediaCheckpointStatus>('status')).lease;if(lease)while(Date.now()<=lease.expiresAt+5)await new Promise(resolve=>setTimeout(resolve,10));};
   // The first unit carries the pre-trailer header; the runtime is destroyed between unit batches.
   const first=await get<Run>('run','&maxUnits=2');expect(first).toMatchObject({outcome:'yielded',units:2});expect(first.status).toMatchObject({phase:'running',revision:2,inputPosition:'10'});
   bucket=await restart();await expire();const second=await get<Run>('run','&maxUnits=1');expect(second).toMatchObject({outcome:'yielded',units:1});expect(second.status).toMatchObject({revision:3,inputPosition:'15'});
   bucket=await restart();await expire();const finished=await get<Run>('run','&maxUnits=8');expect(finished).toMatchObject({outcome:'finished',units:2});
   const status=finished.status!;expect(status).toMatchObject({phase:'finished',lease:null,revision:5,inputPosition:'23'});expect(new Set(status.commits.map(commit=>commit.state.key.split('/').slice(2,4).join('/'))).size).toBe(3);
   const graph=`aformat=sample_fmts=${spec.planar},asetnsamples=n=3:p=${spec.pad}`,common=['-v','error','-cpuflags','0','-f',spec.raw,'-ar','8000','-ac',String(spec.channels),'-i',inputPath,'-af',graph,'-c:a',spec.codec,...(spec.bitexact?['-bitexact']:[])],nativePath=join(directory,spec.name+'.wav');
   execFileSync(binary,[...common,nativePath],{timeout:10000,stdio:'pipe'});const native=readFileSync(nativePath),pipe=execFileSync(binary,[...common,'-f','wav','pipe:1'],{timeout:10000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']});natives.set(spec.name,native);
   expect(BigInt(status.outputPosition)).toBe(BigInt(native.length));
   // Unpatched journal bytes hold native's pre-trailer placeholders and differ from the seekable output only in the rewritten size fields.
   const raw=Buffer.from(await(await mf.dispatchFetch('https://wav.test/raw'+query(''))).arrayBuffer()),dataSize=native.indexOf('data')+4,fact=native.indexOf('fact');expect(raw.length).toBe(native.length);
   const rewritten=new Set([4,5,6,7,dataSize,dataSize+1,dataSize+2,dataSize+3,...(fact>=0?[fact+8,fact+9,fact+10,fact+11]:[])]);for(let i=0;i<raw.length;i++)if(raw[i]!==native[i])expect(rewritten.has(i),'byte '+i).toBe(true);
   expect(raw.readUInt32LE(4)).toBe(0xffffffff);expect(raw.readUInt32LE(dataSize)).toBe(0xffffffff);
   if(spec.codec==='pcm_f32le'){expect(fact).toBe(38);expect(raw.readUInt32LE(fact+8)).toBe(0);expect(native.readUInt32LE(fact+8)).toBe(spec.pad?24:23);expect(Buffer.concat([raw.subarray(0,fact),raw.subarray(fact+12)])).toEqual(pipe);}
   else{expect(fact).toBe(-1);expect(raw.subarray(0,pipe.length)).toEqual(pipe);expect(raw.length-pipe.length).toBe(spec.name==='u8-odd'?1:0);}
   if(spec.name==='u8-odd'){expect(native.readUInt32LE(dataSize)).toBe(23);expect(native.at(-1)).toBe(0);}
   if(spec.bitexact)expect(native.includes('LIST')).toBe(false);else expect(native.includes('Lavf63.1.102')).toBe(true);
   const published=await get<Final>('finalize');expect(published).toMatchObject({ok:true,existing:false,bytes:String(native.length),outputChunks:5,opens:1,stages:0,uploads:1,live:0});
   const object=(await bucket.get('final/'+spec.name+'.wav'))!;expect(Buffer.from(await object.arrayBuffer())).toEqual(native);
   // Replay without overwrite verifies the published object by streamed size + SHA-256 and opens nothing.
   expect(await get<Final>('finalize')).toMatchObject({ok:true,existing:true,bytes:String(native.length),opens:0,stages:0,uploads:0});expect((await bucket.head('final/'+spec.name+'.wav'))!.version).toBe(object.version);
  }
  const spec=cases[0],native=natives.get(spec.name)!,etag=(await bucket.head('inputs/'+spec.name+'.raw'))!.etag,fingerprint=sha(input(spec,samples));
  const finalize=async(extra:string)=>{const response=await mf.dispatchFetch('https://wav.test/finalize?case='+spec.name+'&etag='+encodeURIComponent(etag)+'&fingerprint='+fingerprint+extra),value=await response.json() as Final;expect(response.status,JSON.stringify(value)).toBe(200);return value;};
  // `live` counts staging multipart uploads that still accept a part; staging objects alone miss an unfinished upload.
  expect(await(await mf.dispatchFetch('https://wav.test/probe-control?case='+spec.name+'&fingerprint='+fingerprint)).json()).toEqual({open:1,aborted:0,reprobed:0});
  const publishedVersion=(await bucket.head('final/s16-pad.wav'))!.version,conflicting=Buffer.from(native);conflicting[conflicting.length-1]=conflicting.at(-1)!^1;
  // Existing destination with different bytes of the same size, then with a different size: conflict, nothing opened or replaced.
  const conflictVersion=(await bucket.put('final/s16-conflict.wav',conflicting))!.version;
  expect(await finalize('&target=s16-conflict')).toMatchObject({ok:false,opens:0,stages:0,uploads:0,conflict:{expected:{bytes:String(native.length),sha256:sha(native)},actual:{bytes:String(native.length),sha256:sha(conflicting)}}});expect((await bucket.head('final/s16-conflict.wav'))!.version).toBe(conflictVersion);
  await bucket.put('final/s16-short.wav',native.subarray(0,-2));expect(await finalize('&target=s16-short')).toMatchObject({ok:false,opens:0,stages:0,conflict:{expected:{bytes:String(native.length),sha256:null},actual:{bytes:String(native.length-2),sha256:null}}});
  // A competing identical object wins the conditional put: staging is aborted and the winner verified.
  expect(await finalize('&target=s16-race&mode=race&competitor=final/s16-pad.wav')).toMatchObject({ok:true,existing:true,opens:1,stages:0,uploads:1,live:0});
  const raced=(await bucket.get('final/s16-race.wav'))!;expect(raced.customMetadata?.edgeffmpegTransaction).toBeUndefined();expect(Buffer.from(await raced.arrayBuffer())).toEqual(native);
  expect(await finalize('&target=s16-race-diff&mode=race&competitor=final/s16-conflict.wav')).toMatchObject({ok:false,opens:1,stages:0,live:0,conflict:{actual:{sha256:sha(conflicting)}}});expect(Buffer.from(await(await bucket.get('final/s16-race-diff.wav'))!.arrayBuffer())).toEqual(conflicting);
  // Appearing before the pre-commit recheck aborts the unfinished multipart staging (no live upload), then verifies.
  expect(await finalize('&target=s16-appear&mode=appear&competitor=final/s16-pad.wav')).toMatchObject({ok:true,existing:true,opens:1,stages:0,uploads:1,live:0});expect((await bucket.head('final/s16-appear.wav'))!.customMetadata?.edgeffmpegTransaction).toBeUndefined();
  expect(await finalize('&target=s16-appear-diff&mode=appear&competitor=final/s16-conflict.wav')).toMatchObject({ok:false,opens:1,stages:0,uploads:1,live:0,conflict:{actual:{sha256:sha(conflicting)}}});
  // Definite commit failures with the destination still absent discard the completed staging object too.
  const integrity=await finalize('&target=s16-integrity&mode=integrity');expect(integrity).toMatchObject({ok:false,opens:1,stages:0,uploads:1,live:0,conflict:null});expect(integrity.error).toMatch(/staging integrity check failed/);expect(await bucket.head('final/s16-integrity.wav')).toBeNull();
  const vanished=await finalize('&target=s16-vanish&mode=vanish&competitor=final/s16-pad.wav');expect(vanished).toMatchObject({ok:false,opens:1,stages:0,uploads:1,live:0,conflict:null});expect(vanished.error).toMatch(/already exists/);expect(await bucket.head('final/s16-vanish.wav')).toBeNull();
  // A genuinely uncertain publish keeps staging for transaction-marker recovery.
  expect(await finalize('&target=s16-uncertain&mode=uncertain')).toMatchObject({ok:false,uncertain:true,opens:1,stages:1,uploads:1,live:0,recovered:true,afterRecovery:0});
  expect(Buffer.from(await(await bucket.get('final/s16-uncertain.wav'))!.arrayBuffer())).toEqual(native);expect(await finalize('&target=s16-uncertain')).toMatchObject({ok:true,existing:true,opens:0,stages:0});
  // Invalid patch lists are rejected before any destination is opened.
  for(const mode of ['range','overlap']){const rejected=await finalize('&target=s16-'+mode+'&mode='+mode);expect(rejected).toMatchObject({ok:false,range:true,opens:0,stages:0,uploads:0});expect(rejected.error).toMatch(mode==='range'?/outside the assembled output/:/overlap/);expect(await bucket.head('final/s16-'+mode+'.wav')).toBeNull();}
  // Explicit overwrite keeps its replace-after-verified-staging semantics.
  expect(await finalize('&overwrite=1')).toMatchObject({ok:true,existing:false,opens:1,stages:0});const replaced=(await bucket.get('final/s16-pad.wav'))!;expect(replaced.version).not.toBe(publishedVersion);expect(Buffer.from(await replaced.arrayBuffer())).toEqual(native);
  // Patches come only from pinned terminal state: tampering it blocks both new publication and replay verification.
  const journal=await(await mf.dispatchFetch('https://wav.test/status?case='+spec.name+'&fingerprint='+fingerprint)).json() as MediaCheckpointStatus;await bucket.put(journal.commits.at(-1)!.state.key,Uint8Array.of(255));
  for(const target of ['s16-tampered','s16-pad']){const rejected=await finalize('&target='+target);expect(rejected).toMatchObject({ok:false,opens:0,stages:0,conflict:null});expect(rejected.error).toMatch(/Committed checkpoint objects could not be loaded/);}
  expect(await bucket.head('final/s16-tampered.wav')).toBeNull();expect((await bucket.head('final/s16-pad.wav'))!.version).toBe(replaced.version);
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},120000);
