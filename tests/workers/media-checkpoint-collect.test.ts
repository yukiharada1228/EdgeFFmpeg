import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {MediaCheckpointClaim,MediaCheckpointCollectionReport,MediaCheckpointDescriptor,MediaCheckpointLease,MediaCheckpointStatus} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
it('collects only fenced orphan attempts left by lost acknowledgements and stale owners while committed state/output stay loadable and finalize matches Native',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-media-checkpoint-collect-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 const bundle=await build({entryPoints:[root+'/media-checkpoint-collect-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'media-checkpoint-collect-test',modules:[{type:'ESModule',path:root+'/media-checkpoint-collect-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),durableObjects:{CHECKPOINTS:{className:'MediaCheckpointCoordinator',useSQLite:true}},r2Buckets:['MEDIA_BUCKET']}));let mf=start();
 const request=(path:string,pad:number,body?:object)=>{const [name,query]=path.split('?');return mf.dispatchFetch('https://collect.test/'+name+'?pad='+pad+(query?'&'+query:''),body?{method:'POST',body:JSON.stringify(body)}:{});};
 const call=async<T>(path:string,pad:number,body?:object,status=200)=>{const response=await request(path,pad,body),value=await response.json();expect(response.status,JSON.stringify(value)).toBe(status);return value as T;};
 const expire=async(lease:MediaCheckpointLease)=>{while(Date.now()<=lease.expiresAt+5)await new Promise(resolve=>setTimeout(resolve,10));};
 // Namespace names hash [jobId, workUnitId]; the collector may only touch this prefix.
 const prefix=(pad:number)=>'checkpoints/checkpoint-'+createHash('sha256').update(JSON.stringify(['collect-'+pad,'audio'])).digest('hex')+'/';
 const left=[1,-2,300,-400,32767,-32768,7,-8],right=[-9,10,-1100,1200,-1300,1400,-1500,1600],input=Buffer.alloc(32);for(let i=0;i<8;i++){input.writeInt16LE(left[i]!,i*4);input.writeInt16LE(right[i]!,i*4+2);}writeFileSync(join(directory,'input.raw'),input);
 type Prepared={descriptor:MediaCheckpointDescriptor};const committed=new Map<number,string[]>();
 try{
  await mf.ready;let bucket=await mf.getR2Bucket('MEDIA_BUCKET');const keys=async(pad:number)=>(await bucket.list({prefix:prefix(pad)})).objects.map(object=>object.key).sort();
  for(const pad of [0,1]){
   const root=prefix(pad),collect=(query='')=>call<MediaCheckpointCollectionReport>('collect'+(query?'?'+query:''),pad),claim=(leaseMs:number)=>call<MediaCheckpointClaim>('claim?leaseMs='+leaseMs,pad),prepare=(lease:MediaCheckpointLease,mode='')=>call<Prepared>('prepare'+(mode?'?mode='+mode:''),pad,{lease});
   const attempt=(lease:MediaCheckpointLease,file:string)=>root+lease.generation+'/'+lease.token+'/revision-2/'+file;
   // Owner A: revision 1 is committed but its acknowledgement is lost; revision 2 is staged
   // through a lost output put acknowledgement and never committed.
   const a=(await claim(400)).lease,a1=await prepare(a);expect((await request('commit?lostAck=1',pad,{lease:a,descriptor:a1.descriptor})).status).toBe(503);expect((await call<MediaCheckpointStatus>('status',pad)).commits).toEqual([a1.descriptor]);
   const a2=await prepare(a,'lostPutAck');expect(a2.descriptor.output!.key).toBe(attempt(a,'output.bin'));for(const object of [a2.descriptor.state,a2.descriptor.output!])expect((await bucket.head(object.key))!.version).toBe(object.version);
   const live=await collect();expect(live).toMatchObject({outcome:'live-lease',phase:'running',prefix:root,pages:0,listed:0,next:root,deleted:[],kept:[],skipped:[]});await expire(a);
   // Lease-free journal: only generations up to the last committer (A) are fenced.
   const plan=await collect('dryRun=1');expect(plan).toMatchObject({outcome:'collected',phase:'ready',dryRun:true,listed:4,next:null,deleted:[]});expect(plan.skipped).toEqual([attempt(a,'output.bin'),attempt(a,'state.bin')].map(key=>({key,reason:'dry-run'})));expect(await keys(pad)).toHaveLength(4);
   // Owner B stages state, then its output put fails; owner C prepares fully and goes stale.
   const b=(await claim(300)).lease;expect((await call<{error:string}>('prepare?mode=failOutput',pad,{lease:b},422)).error).toMatch(/could not be prepared.*Injected output put failure/);expect(await bucket.head(attempt(b,'state.bin'))).not.toBeNull();expect(await bucket.head(attempt(b,'output.bin'))).toBeNull();await expire(b);
   const c=(await claim(300)).lease,c2=await prepare(c);await expire(c);
   const fenced=await collect();expect(fenced).toMatchObject({outcome:'collected',phase:'ready',listed:7,skipped:[]});expect(fenced.deleted).toEqual([attempt(a,'output.bin'),attempt(a,'state.bin')].map(key=>({key,reason:'fenced'})));
   expect(fenced.kept).toEqual([...[a1.descriptor.output!.key,a1.descriptor.state.key].map(key=>({key,reason:'committed'})),...[attempt(b,'state.bin'),attempt(c,'output.bin'),attempt(c,'state.bin')].map(key=>({key,reason:'unfenced'}))]);
   // Owner D takes over: C's stale commit is rejected and D's live lease blocks collection.
   const d=(await claim(5000)).lease;expect(d.generation).toBe(4);expect((await call<{error:string}>('commit',pad,{lease:c,descriptor:c2.descriptor},422)).error).toMatch(/Stale/);expect(await collect()).toMatchObject({outcome:'live-lease',listed:0,deleted:[]});
   const d2=await prepare(d),finished=await call<MediaCheckpointStatus>('commit',pad,{lease:d,descriptor:d2.descriptor});expect(finished).toMatchObject({phase:'finished',revision:2,lease:null,outputPosition:pad?'36':'32'});expect(finished.commits).toEqual([a1.descriptor,d2.descriptor]);
   committed.set(pad,[a1.descriptor.state.key,a1.descriptor.output!.key,d2.descriptor.state.key,d2.descriptor.output!.key].sort());
   // A non-attempt key and an attempt-shaped key without the prepare digest marker (a VFS output mounted inside the prefix).
   await bucket.put(root+'notes.txt','not an attempt object');await bucket.put(root+'5/vfs/revision-1/output.bin','vfs destination',{customMetadata:{edgeffmpegTransaction:'t'}});expect(await keys(pad)).toHaveLength(9);
  }
  // Collection after finish runs in a fresh runtime against persisted SQLite and R2.
  await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const pad of [0,1]){
   const root=prefix(pad),collect=(query='')=>call<MediaCheckpointCollectionReport>('collect'+(query?'?'+query:''),pad),strays=[root+'5/vfs/revision-1/output.bin',root+'notes.txt'],orphans=(await keys(pad)).filter(key=>!committed.get(pad)!.includes(key)&&!strays.includes(key)),others=await keys(1-pad);expect(orphans).toHaveLength(3);
   const retained=(report:MediaCheckpointCollectionReport)=>report.kept.map(entry=>entry.key+' '+entry.reason).sort(),expected=(after:string)=>[...committed.get(pad)!.filter(key=>key>after).map(key=>key+' committed'),...strays.map(key=>key+' unrecognized')].sort();
   // The bounded window resumes before its first max-deletes key; continuing from next finishes the pass.
   const bounded=await collect('maxDeletes=1&pageSize=1');expect(bounded).toMatchObject({outcome:'collected',phase:'finished',pages:9,listed:9,next:orphans[0]});expect(bounded.deleted).toEqual([{key:orphans[0],reason:'terminal'}]);expect(bounded.skipped).toEqual(orphans.slice(1).map(key=>({key,reason:'max-deletes'})));expect(retained(bounded)).toEqual(expected(''));
   const rest=await collect('startAfter='+encodeURIComponent(bounded.next!));expect(rest).toMatchObject({outcome:'collected',phase:'finished',listed:6,next:null,skipped:[]});expect(rest.deleted).toEqual(orphans.slice(1).map(key=>({key,reason:'terminal'})));expect(retained(rest)).toEqual(expected(orphans[0]!));
   expect(await keys(pad)).toEqual([...committed.get(pad)!,...strays].sort());expect(await keys(1-pad)).toEqual(others);
   // Referenced objects still verify: load reads every committed state and output; finalize publishes Native bytes.
   const output=join(directory,'native-'+pad+'.raw');execFileSync(binary,['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i',join(directory,'input.raw'),'-filter_complex',`[0:a]aformat=sample_fmts=s16p,asetnsamples=n=3:p=${pad},asetpts=PTS+123[a]`,'-map','[a]','-c:a','pcm_s16le','-f','s16le',output],{timeout:10000,maxBuffer:1048576,stdio:'pipe'});const native=readFileSync(output);expect(native.length).toBe(pad?36:32);
   const loaded=await request('load',pad);expect(loaded.status).toBe(200);expect(Buffer.from(await loaded.arrayBuffer())).toEqual(native);
   expect(await call<{bytes:string;revisions:number;outputChunks:number;stages:number}>('finalize',pad)).toEqual({bytes:String(native.length),revisions:2,outputChunks:2,stages:0});
   const published=(await bucket.get('final/collect-'+pad+'.raw'))!;expect(Buffer.from(await published.arrayBuffer())).toEqual(native);
   // Replayed collection is a no-op and never reaches the published destination.
   const replay=await collect();expect(replay).toMatchObject({outcome:'collected',listed:6,next:null,deleted:[],skipped:[]});expect(retained(replay)).toEqual(expected(''));expect((await bucket.head('final/collect-'+pad+'.raw'))!.version).toBe(published.version);expect((await bucket.list({prefix:'final-stage/'})).objects).toEqual([]);
  }
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},120000);
