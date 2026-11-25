import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {pinnedReference} from '../helpers/reference-identity.js';
// Same order as pad-checkpoint-fixture.ts; split 2 lands between input frames, split 4 after the first silence packet.
const filters=['pad_len=5:packet_size=2','whole_len=13:packet_size=3','pad_dur=625us:packet_size=4','whole_dur=0.002','whole_len=4:packet_size=2'],splits=[2,4];
const expected=[[[2,131],[2,133],[1,135]],[[3,131],[2,134]],[[4,131],[1,135]],[[8,131]],[]].map(tail=>[{samples:3,pts:'123'},{samples:3,pts:'126'},{samples:2,pts:'129'},...tail.map(([samples,pts])=>({samples:samples!,pts:String(pts)}))]);
it('restores serialized apad state in a fresh Worker and matches uninterrupted Native PCM and framecrc timestamps',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-pad-handoff-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(pinnedReference().ffmpeg);
 const bundle=await build({entryPoints:[root+'/pad-checkpoint-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'pad-handoff',modules:[{type:'ESModule',path:root+'/pad-checkpoint-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),r2Buckets:['MEDIA_BUCKET']}));let mf=start();
 type Result={metadata:{samples:number;pts:string}[];bytes:number;checkpointBytes?:number;filterStateRef?:string};
 const call=async(path:string,index:number,split:number,mode='')=>{const response=await mf.dispatchFetch('https://checkpoint.test/'+path+'?case='+index+'&split='+split+'&mode='+mode);const result=await response.json() as Result&{error?:string};return {status:response.status,result};};
 try{
  const left=[1,-2,300,-400,32767,-32768,7,-8],right=[-9,10,-1100,1200,-1300,1400,-1500,1600],input=Buffer.alloc(32);for(let i=0;i<8;i++){input.writeInt16LE(left[i]!,i*4);input.writeInt16LE(right[i]!,i*4+2);}writeFileSync(join(directory,'input.raw'),input);
  const native=filters.map((filter,index)=>{
   const output=join(directory,'native'+index+'.raw'),crc=join(directory,'native'+index+'.crc');
   execFileSync(binary,['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i',join(directory,'input.raw'),'-filter_complex',`[0:a]aformat=sample_fmts=s16p,asetnsamples=n=3:p=0,apad=${filter},asetpts=PTS+123,asplit=2[a][b]`,'-map','[a]','-c:a','pcm_s16le','-f','s16le',output,'-map','[b]','-c:a','pcm_s16le','-f','framecrc',crc],{timeout:10000,maxBuffer:1048576,stdio:'pipe'});
   return {pcm:readFileSync(output),packets:readFileSync(crc,'utf8').split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const fields=line.split(',').map(value=>value.trim());return {samples:Number(fields[3]),pts:fields[2]!};})};
  });
  for(const [index,reference]of native.entries())expect(reference.packets,filters[index]).toEqual(expected[index]);
  const stateRefs=new Map<string,string>();
  await mf.ready;let bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const index of filters.keys())for(const split of splits){
   const first=await call('first',index,split),committed=expected[index]!.slice(0,split);expect(first.status,first.result.error).toBe(200);expect(first.result.metadata).toEqual(committed);expect(first.result.checkpointBytes).toBeGreaterThan(0);expect(first.result.checkpointBytes).toBeLessThan(1024);expect(first.result.filterStateRef).toMatch(/^states\/apad-[a-f0-9]{64}\.bin$/);
   stateRefs.set(index+'/'+split,first.result.filterStateRef!);expect((await bucket.head('c'+index+'s'+split+'/committed.pcm'))!.size).toBe(committed.reduce((size,item)=>size+item.samples*4,0));
  }
  // No state object or JavaScript closure survives this disposal.
  await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  {
   const prefix='c0s4/',stateKey=stateRefs.get('0/4')!,before=Buffer.from(await(await bucket.get(stateKey))!.arrayBuffer());
   for(const mode of ['cancelled','budget']){const rejected=await call('resume',0,4,mode);expect(rejected.status).toBe(422);expect(rejected.result.error).toMatch(mode==='budget'?/allocation/:/cancellation/);expect(await bucket.get(prefix+'resumed.pcm')).toBeNull();expect(Buffer.from(await(await bucket.get(stateKey))!.arrayBuffer())).toEqual(before);}
   // Wrong envelope identity rejects before even decoding a deliberately corrupt state blob.
   await bucket.put(stateKey,Uint8Array.of(255));const mismatch=await call('resume',0,4,'identity-mismatch');expect(mismatch.status).toBe(422);expect(mismatch.result.error).toMatch(/identity|implementation/i);const tampered=await call('resume',0,4);expect(tampered.status).toBe(422);expect(tampered.result.error).toMatch(/digest/i);expect(await bucket.get(prefix+'resumed.pcm')).toBeNull();await bucket.put(stateKey,before);
  }
  for(const [index,reference]of native.entries())for(const split of splits){
   const prefix='c'+index+'s'+split+'/',resumed=await call('resume',index,split),full=await call('full',index,split);expect(resumed.status,resumed.result.error).toBe(200);expect(full.status,full.result.error).toBe(200);
   expect(resumed.result).toEqual(full.result);expect(resumed.result.metadata).toEqual(reference.packets);
   const actual=Buffer.from(await(await bucket.get(prefix+'resumed.pcm'))!.arrayBuffer());expect(actual).toEqual(Buffer.from(await(await bucket.get(prefix+'full.pcm'))!.arrayBuffer()));expect(actual).toEqual(reference.pcm);
  }
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},120000);
