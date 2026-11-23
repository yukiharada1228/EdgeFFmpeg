import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {MediaJobSpec,MediaJobStatus,MediaJobClaim} from '@edge-ffmpeg/runtime-cloudflare/jobs';
const args=['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i','/input/media.raw','-af','volume=0.5','-c:a','pcm_s16le','-f','wav','/output/media.wav'];
const input=Uint8Array.from({length:1028},(_,i)=>(i*37+11)%256);
it('runs durable media jobs with SQLite, actual Queue delivery, R2 and fenced replay across restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-media-job-')),root=resolve('tests/workers');
 const bundle=await build({entryPoints:[root+'/durable-media-job-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});
 for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=(autoRun='no')=>new Miniflare(convertV4MiniflareOptions({name:'media-job-test',modules:[{type:'ESModule',path:root+'/durable-media-job-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:directory,bindings:{AUTO_RUN:autoRun},durableObjects:{JOBS:{className:'MediaJobCoordinator',useSQLite:true}},r2Buckets:['MEDIA_BUCKET'],queueProducers:{MEDIA_JOB_QUEUE:'media-jobs'},queueConsumers:{'media-jobs':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:1,retryDelay:0}}}));
 let mf=start();
 const call=async<T>(path:string,jobId:string,body:object={}):Promise<T>=>{
  const response=await mf.dispatchFetch('https://jobs.test/'+path+'?jobId='+jobId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  expect(response.status).toBe(200);const data=await response.json() as {ok:boolean;result:T;error?:string};expect(data.ok,data.error).toBe(true);return data.result;
 };
 const rejected=async(path:string,jobId:string,body:object)=>{const response=await mf.dispatchFetch('https://jobs.test/'+path+'?jobId='+jobId,{method:'POST',body:JSON.stringify(body)});expect(await response.json()).toMatchObject({ok:false});};
 const spec=async(jobId:string,leaseMs=1000)=>call<MediaJobSpec>('build',jobId,{args,leaseMs});
 const submit=async(jobId:string,leaseMs=1000)=>{const value=await spec(jobId,leaseMs);await call('submit',jobId,{spec:value});return value;};
 const status=(id:string)=>call<MediaJobStatus>('status',id);
 const waitUntil=async(predicate:()=>Promise<boolean>,maximumMs=5000)=>{const end=Date.now()+maximumMs;while(!await predicate()){if(Date.now()>end)throw Error('Timed out awaiting job state');await new Promise(resolve=>setTimeout(resolve,20));}};
 try{
  await mf.ready;let bucket=await mf.getR2Bucket('MEDIA_BUCKET');await bucket.put('source/media.raw',input);
  // Actual public media backend supplies an independent single-worker baseline.
  const baselineResult=await call<{exitCode:number;diagnostics:unknown}>('single','baseline',{args});expect(baselineResult.exitCode,JSON.stringify(baselineResult.diagnostics)).toBe(0);
  const baseline=Buffer.from(await (await bucket.get('baseline/media.wav'))!.arrayBuffer());expect(baseline.length).toBeGreaterThan(input.length);
  await submit('duplicate');
  const delivered=await Promise.all([call('consume','duplicate'),call('consume','duplicate')]);expect(delivered).toHaveLength(2);
  const done=await status('duplicate');expect(done.phase).toBe('succeeded');expect(done.attempts).toBe(1);expect(done.artifacts).toHaveLength(1);
  expect(Buffer.from(await (await bucket.get(done.artifacts[0]!.key))!.arrayBuffer())).toEqual(baseline);
  const keysBefore=(await bucket.list({prefix:'jobs/duplicate/'})).objects.map(item=>item.key);await call('consume','duplicate');expect((await bucket.list({prefix:'jobs/duplicate/'})).objects.map(item=>item.key)).toEqual(keysBefore);
  // Immutable submit identity, persisted state and output survive full runtime restart.
  const wrongNamespace=await spec('namespace-owner');await rejected('submit','namespace-other',{spec:wrongNamespace});
  const persistent=await submit('restart');await rejected('submit','restart',{spec:{...persistent,implementationVersion:'changed'}});
  await submit('running-restart',1000);const running=await call<MediaJobClaim>('claim','running-restart');
  await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');expect((await status('duplicate')).phase).toBe('succeeded');expect((await status('restart')).phase).toBe('queued');expect((await status('running-restart')).generation).toBe(running.lease.generation);expect((await status('running-restart')).attempts).toBe(1);await call('cancel','running-restart');
  await call('consume','restart');expect((await status('restart')).phase).toBe('succeeded');
  // Expired owner cannot renew, complete or overwrite a newer successful attempt.
  await submit('fence',150);const old=await call<MediaJobClaim>('claim','fence');expect(old).not.toBeNull();
  await waitUntil(async()=>Date.now()>old.lease.expiresAt+5);
  const next=await call<MediaJobClaim>('claim','fence');expect(next.lease.generation).toBeGreaterThan(old.lease.generation);
  expect(await call('check','fence',{lease:old.lease})).toBe(false);expect(await call('heartbeat','fence',{lease:old.lease})).toBeNull();
  await rejected('succeed','fence',{lease:old.lease,artifacts:[]});await rejected('fail','fence',{lease:old.lease,error:'stale'});
  const fencedKey=`jobs/fence/${next.lease.generation}/${next.lease.token}/media.wav`,fencedObject=await bucket.put(fencedKey,baseline);
  const artifact={path:'/output/media.wav',key:fencedKey,etag:fencedObject!.etag,version:fencedObject!.version,size:baseline.length};
  await call('succeed','fence',{lease:next.lease,artifacts:[artifact]});await rejected('succeed','fence',{lease:old.lease,artifacts:[artifact]});expect((await status('fence')).artifacts).toEqual([artifact]);
  // Cancellation during real backend execution fences artifact publication.
  await submit('cancel-race');expect(await call('consume','cancel-race',{mode:'cancel-race'})).toMatchObject({kind:'terminal',status:{phase:'cancelled'}});expect((await status('cancel-race')).phase).toBe('cancelled');expect((await status('cancel-race')).artifacts).toEqual([]);
  // A lost success response resolves by persisted status on redelivery.
  await submit('lost-success');expect(await call('consume','lost-success',{mode:'lost-success'})).toMatchObject({kind:'terminal',status:{phase:'succeeded'}});const lost=await status('lost-success');expect(lost.phase,JSON.stringify(lost)).toBe('succeeded');
  await call('consume','lost-success');expect((await status('lost-success')).artifacts).toEqual(lost.artifacts);expect((await status('lost-success')).attempts).toBe(1);
  // Pins reject both changed content and same-content replacement versions.
  for(const [id,bytes] of [['etag-change',Uint8Array.of(1,2,3,4)],['version-change',input]] as const){
   await bucket.put('source/media.raw',input);await submit(id);await bucket.put('source/media.raw',bytes);await call('consume',id);const changed=await status(id);expect(changed.phase).not.toBe('succeeded');expect(changed.artifacts).toEqual([]);
  }
  await bucket.put('source/media.raw',input);await submit('implementation-change');await call('consume','implementation-change',{mode:'version-mismatch'});expect((await status('implementation-change')).phase).toBe('queued');await call('consume','implementation-change',{mode:'version-mismatch'});expect((await status('implementation-change')).phase).toBe('failed');expect((await status('implementation-change')).attempts).toBe(2);
  // This uses the actual Queue producer and consumer, rather than the manual race route.
  await mf.dispose();mf=start('yes');await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');await submit('queue-smoke');
  await waitUntil(async()=>(await status('queue-smoke')).phase==='succeeded');
  const queued=await status('queue-smoke');expect(queued.attempts).toBe(1);expect(Buffer.from(await (await bucket.get(queued.artifacts[0]!.key))!.arrayBuffer())).toEqual(baseline);
  expect((await bucket.list({prefix:'baseline-stage/'})).objects).toEqual([]);
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},120000);
