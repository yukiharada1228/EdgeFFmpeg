import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {pinnedReference} from '../helpers/reference-identity.js';
it('restores serialized planar audio reframe state in a fresh Worker and matches uninterrupted Native samples and timestamps',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-reframe-handoff-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(pinnedReference().ffmpeg);
 const bundle=await build({entryPoints:[root+'/reframe-checkpoint-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'reframe-handoff',modules:[{type:'ESModule',path:root+'/reframe-checkpoint-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),r2Buckets:['MEDIA_BUCKET']}));let mf=start();
 type Result={metadata:{samples:number;pts:string}[];bytes:number;checkpointBytes?:number;filterStateRef?:string};
 const call=async(path:string,pad:number,mode='')=>{const response=await mf.dispatchFetch('https://checkpoint.test/'+path+'?pad='+pad+'&mode='+mode);const result=await response.json() as Result&{error?:string};return {status:response.status,result};};
 try{
  const stateRefs=new Map<number,string>();
  await mf.ready;let bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const pad of [0,1]){const first=await call('first',pad);expect(first.status,first.result.error).toBe(200);expect(first.result.metadata).toEqual([{samples:3,pts:'123'}]);expect(first.result.checkpointBytes).toBeGreaterThan(0);expect(first.result.filterStateRef).toMatch(/^states\/reframe-[a-f0-9]{64}\.bin$/);stateRefs.set(pad,first.result.filterStateRef!);expect((await bucket.head('p'+pad+'/committed.pcm'))!.size).toBe(12);}
  // No state object, pending plane view, or JavaScript closure survives this disposal.
  await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const pad of [0,1]){
   const prefix='p'+pad+'/',stateKey=stateRefs.get(pad)!,before=Buffer.from(await(await bucket.get(stateKey))!.arrayBuffer());
   for(const mode of ['cancelled','budget']){const rejected=await call('resume',pad,mode);expect(rejected.status).toBe(422);expect(await bucket.get(prefix+'resumed.pcm')).toBeNull();expect(Buffer.from(await(await bucket.get(stateKey))!.arrayBuffer())).toEqual(before);expect((await bucket.head(prefix+'committed.pcm'))!.size).toBe(12);}
   // Wrong envelope identity rejects before even decoding a deliberately corrupt state blob.
   await bucket.put(stateKey,Uint8Array.of(255));const mismatch=await call('resume',pad,'identity-mismatch');expect(mismatch.status).toBe(422);expect(mismatch.result.error).toMatch(/identity|implementation/i);const tampered=await call('resume',pad);expect(tampered.status).toBe(422);expect(tampered.result.error).toMatch(/digest/i);expect(await bucket.get(prefix+'resumed.pcm')).toBeNull();await bucket.put(stateKey,before);
   const resumed=await call('resume',pad),full=await call('full',pad);expect(resumed.status,resumed.result.error).toBe(200);expect(full.status,full.result.error).toBe(200);expect(resumed.result).toEqual(full.result);expect(resumed.result.metadata).toEqual([{samples:3,pts:'123'},{samples:3,pts:'126'},{samples:pad?3:2,pts:'129'}]);
   const actual=Buffer.from(await(await bucket.get(prefix+'resumed.pcm'))!.arrayBuffer());expect(actual).toEqual(Buffer.from(await(await bucket.get(prefix+'full.pcm'))!.arrayBuffer()));
   const left=[1,-2,300,-400,32767,-32768,7,-8],right=[-9,10,-1100,1200,-1300,1400,-1500,1600],input=Buffer.alloc(32);for(let i=0;i<8;i++){input.writeInt16LE(left[i]!,i*4);input.writeInt16LE(right[i]!,i*4+2);}writeFileSync(join(directory,'input.raw'),input);
   const output=join(directory,'p'+pad+'.raw'),crc=join(directory,'p'+pad+'.crc');execFileSync(binary,['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i',join(directory,'input.raw'),'-filter_complex',`[0:a]aformat=sample_fmts=s16p,asetnsamples=n=3:p=${pad},asetpts=PTS+123,asplit=2[a][b]`,'-map','[a]','-c:a','pcm_s16le','-f','s16le',output,'-map','[b]','-c:a','pcm_s16le','-f','framecrc',crc],{timeout:10000,maxBuffer:1048576,stdio:'pipe'});
   expect(actual).toEqual(readFileSync(output));const packets=readFileSync(crc,'utf8').split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const fields=line.split(',').map(value=>value.trim());return {samples:Number(fields[3]),pts:fields[2]!};});expect(resumed.result.metadata).toEqual(packets);
  }
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},120000);
