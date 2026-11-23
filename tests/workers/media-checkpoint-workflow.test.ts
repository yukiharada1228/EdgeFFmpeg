import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {MediaCheckpointClaim,MediaCheckpointStatus,MediaCheckpointWorkflowCancellation,MediaCheckpointWorkflowManifest,MediaCheckpointWorkflowSpec} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
type Instance={status:string;output?:MediaCheckpointWorkflowManifest|null;error?:{name?:string;message:string}|null;__LOCAL_DEV_STEP_OUTPUTS?:unknown[]};
type Created={id:string;spec:MediaCheckpointWorkflowSpec;foreign:MediaCheckpointClaim|null};
it('schedules an R2-backed audio FIFO through actual Workflows to Native-identical bytes across a full runtime restart, with replay, busy, cancellation and conflict outcomes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-media-checkpoint-workflow-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
 const bundle=await build({entryPoints:[root+'/media-checkpoint-workflow-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'media-checkpoint-workflow-test',modules:[{type:'ESModule',path:root+'/media-checkpoint-workflow-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),durableObjects:{CHECKPOINTS:{className:'MediaCheckpointCoordinator',useSQLite:true}},r2Buckets:['MEDIA_BUCKET'],workflows:{CHECKPOINT_WORKFLOW:{name:'media-checkpoint-workflow-local',className:'FifoCheckpointWorkflow'}}}));let mf=start();
 // 23 stereo samples (not a multiple of the 5-sample unit or 3-sample frame), including int16 extremes.
 const samples=23,input=Buffer.alloc(samples*4);for(let i=0;i<samples;i++){input.writeInt16LE(i===3?32767:i===4?-32768:((i*7919)%65536)-32768,i*4);input.writeInt16LE(i===5?-32768:((i*104729+17)%65536)-32768,i*4+2);}
 const inputPath=join(directory,'input.raw');writeFileSync(inputPath,input);
 const call=async<T>(path:string,body?:unknown,status=200):Promise<T>=>{const response=await mf.dispatchFetch('https://checkpoint-workflow.test'+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),value=await response.json() as T;expect(response.status,JSON.stringify(value)).toBe(status);return value;};
 const instance=(id:string)=>call<Instance>('/status?id='+id),journal=(spec:MediaCheckpointWorkflowSpec)=>call<MediaCheckpointStatus>('/journal',spec);
 const wait=async(id:string,phase:string,timeout=60000)=>{const end=Date.now()+timeout;for(;;){const value=await instance(id);if(value.status===phase)return value;if(['errored','terminated','complete'].includes(value.status)&&value.status!==phase)throw Error('Unexpected workflow status '+JSON.stringify(value));if(Date.now()>end)throw Error('Workflow timeout '+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,25));}};
 const create=(id:string,options:Record<string,unknown>)=>call<Created>('/create?id='+id,{pad:0,unitsPerInvocation:1,leaseMs:3000,...options});
 let bucket=await(async()=>{await mf.ready;return mf.getR2Bucket('MEDIA_BUCKET');})();
 const restart=async()=>{await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');};
 const bytes=async(key:string)=>Buffer.from(await(await bucket.get(key))!.arrayBuffer());
 try{
  await bucket.put('inputs/fifo.s16le',input);
  const native=[0,1].map(pad=>{
   const output=join(directory,'native-'+pad+'.raw'),crc=join(directory,'native-'+pad+'.crc');
   execFileSync(binary,['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i',inputPath,'-filter_complex',`[0:a]aformat=sample_fmts=s16p,asetnsamples=n=3:p=${pad},asetpts=PTS+123,asplit=2[a][b]`,'-map','[a]','-c:a','pcm_s16le','-f','s16le',output,'-map','[b]','-c:a','pcm_s16le','-f','framecrc',crc],{timeout:10000,maxBuffer:1048576,stdio:'pipe'});
   return {bytes:readFileSync(output),frames:readFileSync(crc,'utf8').split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const fields=line.split(',').map(value=>value.trim());return {samples:Number(fields[3]),pts:fields[2]!};})};
  });
  expect(native.map(value=>value.bytes.length)).toEqual([92,96]);expect(native.map(value=>value.frames.length)).toEqual([8,8]);

  // A: one 5-sample unit per durable step, slowed so the whole runtime is destroyed mid-flight; one injected transient R2 failure.
  const a=await create('fifo-0',{jobId:'fifo-0',path:'/output/fifo-0.raw',delayMs:300,faultAt:'10'});
  for(const end=Date.now()+30000;(await journal(a.spec)).revision<2;){if(Date.now()>end)throw Error('No committed progress');await new Promise(resolve=>setTimeout(resolve,20));}
  await restart();const interrupted=await journal(a.spec);expect(interrupted.revision).toBeGreaterThanOrEqual(2);expect(interrupted.revision).toBeLessThan(5);
  // Local Workflows schedules no wake-up after a process restart, so the persisted instance is reactivated
  // explicitly; its completed steps replay from the engine's cache and the interrupted step re-runs.
  expect((await instance('fifo-0')).status).toBe('running');await call('/pause?id=fifo-0');await wait('fifo-0','paused');await call('/resume?id=fifo-0');
  const done=await wait('fifo-0','complete'),manifest=done.output!;
  const finished=await journal(a.spec);expect(finished).toMatchObject({phase:'finished',lease:null,revision:5,inputPosition:'23',outputPosition:'92'});expect(finished.commits.map(commit=>commit.revision)).toEqual([1,2,3,4,5]);
  // The pre-restart prefix is unchanged and was written by the first lease alone; owners never interleave afterwards
  // (a re-run step resumes a lease only from a settled predecessor, otherwise it claims a newer generation).
  const owner=(commit:{state:{key:string}})=>commit.state.key.split('/').slice(2,4).join('/'),generation=(commit:{state:{key:string}})=>Number(commit.state.key.split('/')[2]);
  expect(finished.commits.slice(0,interrupted.revision)).toEqual(interrupted.commits);expect(new Set(interrupted.commits.map(owner))).toEqual(new Set([owner(interrupted.commits[0]!)]));expect(generation(interrupted.commits[0]!)).toBe(1);
  const generations=finished.commits.map(generation);expect(generations).toEqual([...generations].sort((x,y)=>x-y));expect(new Set(finished.commits.map(owner)).size).toBe(new Set(generations).size);
  expect(await bucket.head('faults/fifo-0/10')).not.toBeNull();expect(await bytes('final/fifo-0.raw')).toEqual(native[0]!.bytes);expect(await call('/frames',a.spec)).toEqual(native[0]!.frames);expect((await bucket.list({prefix:'final-stage/'})).objects).toEqual([]);
  const units=(done.__LOCAL_DEV_STEP_OUTPUTS??[]) as {outcome?:string}[];expect(units.filter(unit=>unit.outcome==='yielded').length).toBeGreaterThanOrEqual(3);expect(units.at(-2)).toMatchObject({outcome:'finished',revision:5,bytes:'92'});
  const nativeSha256=createHash('sha256').update(native[0]!.bytes).digest('hex');
  expect(manifest).toMatchObject({workflowId:'fifo-0',specHash:a.spec.specHash,key:`checkpoint-workflows/fifo-0/${a.spec.specHash}.json`,path:'/output/fifo-0.raw',bytes:'92',outputSha256:nativeSha256,revisions:5});
  const stored=(await bucket.get(manifest.key))!;expect(stored.etag).toBe(manifest.etag);expect(stored.version).toBe(manifest.version);const body=await stored.json() as {identity:unknown;output:unknown;journal:{sha256:string}};
  expect(body).toMatchObject({identity:a.spec.identity,output:{path:'/output/fifo-0.raw',bytes:'92',sha256:nativeSha256,revisions:5,outputChunks:5},journal:{revision:5,inputPosition:'23',outputPosition:'92',sha256:manifest.journalSha256}});
  // Replay idempotency: republishing verifies the stored manifest, and another instance for the same identity verifies the destination.
  const destination=(await bucket.head('final/fifo-0.raw'))!.version;expect(await call('/publish',a.spec)).toEqual(manifest);
  const replay=await create('fifo-0-replay',{jobId:'fifo-0',path:'/output/fifo-0.raw',delayMs:300,faultAt:'10'});expect(replay.spec.identity).toEqual(a.spec.identity);
  const replayed=await wait('fifo-0-replay','complete');expect(replayed.output).toMatchObject({key:`checkpoint-workflows/fifo-0-replay/${replay.spec.specHash}.json`,journalSha256:manifest.journalSha256,bytes:'92'});
  expect(((replayed.__LOCAL_DEV_STEP_OUTPUTS??[]) as {outcome?:string}[]).find(unit=>unit.outcome==='finished')).toMatchObject({existing:true});expect((await bucket.head('final/fifo-0.raw'))!.version).toBe(destination);
  await restart();expect((await instance('fifo-0')).output).toEqual(manifest);expect((await bucket.head(manifest.key))!.version).toBe(manifest.version);expect((await bucket.head('final/fifo-0.raw'))!.version).toBe(destination);
  // Cancelling after the journal finished fences nothing and leaves the instance alone.
  expect(await call('/cancel',a.spec)).toMatchObject({ok:true,result:{journalPhase:'finished',revision:5,workflowStatus:'complete'}});expect((await instance('fifo-0')).status).toBe('complete');expect(await journal(a.spec)).toEqual(finished);

  // B: another owner's live lease makes the first step busy; the instance sleeps until its reported expiry, then claims.
  const b=await create('fifo-1',{jobId:'fifo-1',pad:1,path:'/output/fifo-1.raw',unitsPerInvocation:2,leaseMs:2000,foreignLeaseMs:1500});const foreign=b.foreign!;expect(foreign.lease.generation).toBe(1);
  const doneB=await wait('fifo-1','complete'),stepsB=(doneB.__LOCAL_DEV_STEP_OUTPUTS??[]) as {outcome?:string;wakeAt?:number}[];
  expect(stepsB.find(unit=>unit.outcome==='busy')!.wakeAt).toBeGreaterThanOrEqual(foreign.lease.expiresAt+50);expect(stepsB.filter(unit=>unit.outcome==='yielded')).toHaveLength(2);
  const finishedB=await journal(b.spec);expect(finishedB).toMatchObject({phase:'finished',revision:5,outputPosition:'96'});expect(finishedB.commits.every(commit=>!commit.state.key.includes('/'+foreign.lease.token+'/'))).toBe(true);
  expect(new Set(finishedB.commits.map(commit=>commit.state.key.split('/').slice(2,4).join('/'))).size).toBe(1);expect(await bytes('final/fifo-1.raw')).toEqual(native[1]!.bytes);expect(await call('/frames',b.spec)).toEqual(native[1]!.frames);

  // C: cancellation fences the journal, then terminates; nothing commits afterwards and a late instance ends cancelled.
  const c=await create('fifo-cancel',{jobId:'fifo-cancel',path:'/output/fifo-cancel.raw',delayMs:400});
  for(const end=Date.now()+30000;(await journal(c.spec)).revision<1;){if(Date.now()>end)throw Error('No committed progress');await new Promise(resolve=>setTimeout(resolve,20));}
  const cancelled=await call<{ok:boolean;result:MediaCheckpointWorkflowCancellation}>('/cancel',c.spec);expect(cancelled).toMatchObject({ok:true,result:{workflowId:'fifo-cancel',journalPhase:'cancelled',workflowStatus:'terminated'}});
  expect((await instance('fifo-cancel')).status).toBe('terminated');const fenced=await journal(c.spec);expect(fenced).toMatchObject({phase:'cancelled',lease:null,revision:cancelled.result.revision});
  await new Promise(resolve=>setTimeout(resolve,1200));expect(await journal(c.spec)).toEqual(fenced);expect(await bucket.head('final/fifo-cancel.raw')).toBeNull();expect((await bucket.list({prefix:'checkpoint-workflows/fifo-cancel/'})).objects).toEqual([]);
  expect(await call('/cancel',c.spec)).toMatchObject({ok:true,result:{journalPhase:'cancelled',workflowStatus:'terminated'}});
  await create('fifo-cancel-late',{jobId:'fifo-cancel',path:'/output/fifo-cancel.raw',delayMs:400});const late=await wait('fifo-cancel-late','errored');expect(late.error!.message).toMatch(/ended with cancelled at revision/);expect(await journal(c.spec)).toEqual(fenced);

  // D: a different object already at the no-clobber destination is an output conflict, never overwritten or published.
  const foreignObject=(await bucket.put('final/fifo-conflict.raw',Buffer.alloc(92,7)))!.version;
  const d=await create('fifo-conflict',{jobId:'fifo-conflict',path:'/output/fifo-conflict.raw',unitsPerInvocation:8});const conflict=await wait('fifo-conflict','errored');
  expect(conflict.error!.message).toMatch(/ended with output-conflict at revision 5: \/output\/fifo-conflict\.raw holds 92 bytes/);expect((await bucket.head('final/fifo-conflict.raw'))!.version).toBe(foreignObject);expect(await bytes('final/fifo-conflict.raw')).toEqual(Buffer.alloc(92,7));
  // Direct publication verifies the destination itself, so it refuses the foreign object too.
  expect((await call<{error:string}>('/publish',d.spec,500)).error).toMatch(/exists with different content/);
  expect(await journal(d.spec)).toMatchObject({phase:'finished',revision:5});expect((await bucket.list({prefix:'checkpoint-workflows/fifo-conflict/'})).objects).toEqual([]);expect((await bucket.list({prefix:'final-stage/'})).objects).toEqual([]);

  // E: a spec whose implementation version the Worker's registry does not provide fails validation before any unit.
  const e=await create('fifo-version',{jobId:'fifo-version',path:'/output/fifo-version.raw',implementationVersion:'reframe-workflow-v0'});const mismatch=await wait('fifo-version','errored');expect(mismatch.error!.message).toMatch(/implementation version mismatch/);
  expect(await journal(e.spec)).toMatchObject({phase:'ready',revision:0,lease:null});expect(await bucket.head('final/fifo-version.raw')).toBeNull();
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},180000);
