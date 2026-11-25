import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {pinnedReference} from '../helpers/reference-identity.js';
// Same order as resample-checkpoint-fixture.ts. Split 3 lands mid-stream, 8 after the last input frame, 9 after one EOF tail frame.
const rates=[[44100,48000],[48000,8000],[44100,48001],[8000,44100]] as const,splits=[3,8,9],samples=400;
it('restores serialized resampler state in a fresh Worker and matches uninterrupted and pinned Native aresample PCM',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-resample-handoff-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(pinnedReference().ffmpeg);
 const bundle=await build({entryPoints:[root+'/resample-checkpoint-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'resample-handoff',modules:[{type:'ESModule',path:root+'/resample-checkpoint-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),r2Buckets:['MEDIA_BUCKET']}));let mf=start();
 type Result={metadata:{samples:number;pts:string}[];bytes:number;checkpointBytes?:number;filterStateRef?:string;received?:string;historyBytes?:number;pendingBytes?:number;eof?:boolean;finished?:boolean};
 const call=async(path:string,index:number,split:number,mode='')=>{const response=await mf.dispatchFetch('https://checkpoint.test/'+path+'?case='+index+'&split='+split+'&mode='+mode);const result=await response.json() as Result&{error?:string};return {status:response.status,result};};
 try{
  const input=Buffer.alloc(samples*4);for(let i=0;i<samples;i++)for(let channel=0;channel<2;channel++)input.writeInt16LE((i*3137+channel*7919)%65536-32768,(i*2+channel)*2);writeFileSync(join(directory,'input.raw'),input);
  const native=rates.map(([inputRate,outputRate],index)=>{const output=join(directory,'native'+index+'.raw');execFileSync(binary,['-v','error','-cpuflags','0','-f','s16le','-ar',String(inputRate),'-ac','2','-i',join(directory,'input.raw'),'-af',`aresample=${outputRate}:tsf=s16p`,'-f','s16le',output],{timeout:10000,maxBuffer:1048576,stdio:'pipe'});return readFileSync(output);});
  const stateRefs=new Map<string,string>(),committed=new Map<string,{samples:number;pts:string}[]>(),shapes=new Map<string,Result>();
  await mf.ready;let bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const index of rates.keys())for(const split of splits){
   const first=await call('first',index,split);expect(first.status,first.result.error).toBe(200);expect(first.result.filterStateRef).toMatch(/^states\/resample-[a-f0-9]{64}\.bin$/);expect(first.result.checkpointBytes).toBeGreaterThan(0);expect(first.result.checkpointBytes).toBeLessThan(2048);
   expect(first.result.received).toBe(String(split===3?102:samples));expect(first.result.eof).toBe(split===9);if(split<9)expect(first.result.historyBytes).toBeGreaterThan(0);
   stateRefs.set(index+'/'+split,first.result.filterStateRef!);committed.set(index+'/'+split,first.result.metadata);shapes.set(index+'/'+split,first.result);expect((await bucket.head('c'+index+'s'+split+'/committed.pcm'))!.size).toBe(first.result.metadata.reduce((size,item)=>size+item.samples*4,0));
  }
  // Startup history without output, pending partial output, a mid-tail EOF state and a finished state all cross the runtime boundary.
  expect(shapes.get('1/3')).toMatchObject({metadata:[],historyBytes:408,pendingBytes:0});expect(shapes.get('0/8')!.pendingBytes).toBeGreaterThan(0);expect(splits.flatMap(split=>[...rates.keys()].map(index=>shapes.get(index+'/'+split)!.finished))).toEqual([false,false,false,false,false,false,false,false,true,false,true,false]);
  // No state object, coefficient bank or JavaScript closure survives this disposal.
  await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  {
   const prefix='c0s3/',stateKey=stateRefs.get('0/3')!,before=Buffer.from(await(await bucket.get(stateKey))!.arrayBuffer());
   for(const mode of ['cancelled','budget']){const rejected=await call('resume',0,3,mode);expect(rejected.status).toBe(422);expect(rejected.result.error).toMatch(mode==='budget'?/allocation/:/cancellation/);expect(await bucket.get(prefix+'resumed.pcm')).toBeNull();expect(Buffer.from(await(await bucket.get(stateKey))!.arrayBuffer())).toEqual(before);}
   // Wrong envelope identity rejects before even decoding a deliberately corrupt state blob.
   await bucket.put(stateKey,Uint8Array.of(255));const mismatch=await call('resume',0,3,'identity-mismatch');expect(mismatch.status).toBe(422);expect(mismatch.result.error).toMatch(/identity|implementation/i);const tampered=await call('resume',0,3);expect(tampered.status).toBe(422);expect(tampered.result.error).toMatch(/digest/i);expect(await bucket.get(prefix+'resumed.pcm')).toBeNull();await bucket.put(stateKey,before);
  }
  for(const [index,reference]of native.entries())for(const split of splits){
   const prefix='c'+index+'s'+split+'/',resumed=await call('resume',index,split),full=await call('full',index,split);expect(resumed.status,resumed.result.error).toBe(200);expect(full.status,full.result.error).toBe(200);
   expect(resumed.result).toEqual(full.result);expect(full.result.metadata.slice(0,committed.get(index+'/'+split)!.length)).toEqual(committed.get(index+'/'+split));
   let position=0;for(const item of full.result.metadata){expect(item.pts).toBe(String(position));position+=item.samples;}expect(position*4).toBe(reference.length);
   const actual=Buffer.from(await(await bucket.get(prefix+'resumed.pcm'))!.arrayBuffer());expect(actual).toEqual(Buffer.from(await(await bucket.get(prefix+'full.pcm'))!.arrayBuffer()));expect(actual.equals(reference),`${rates[index]}/${split}`).toBe(true);
  }
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},180000);
