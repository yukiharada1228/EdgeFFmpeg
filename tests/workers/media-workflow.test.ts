import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mediaWorkflowJobId} from '@edge-ffmpeg/runtime-cloudflare/jobs';
import type {MediaWorkflowSpec,MediaWorkflowResult,MediaWorkflowManifest,MediaJobStatus} from '@edge-ffmpeg/runtime-cloudflare/jobs';
const budget={maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:15000,maxPendingPackets:8};
const rawArgs=(name:string)=>['-cpuflags','0','-f','s16le','-ar','8000','-ac','2','-i','/input/media.raw','-af','volume=0.5','-c:a','pcm_s16le','-f','wav','/output/'+name+'.wav'];
const childArgs=['-cpuflags','0','-i','/input/parent.wav','-af','volume=0.25','-c:a','pcm_s16le','-f','wav','/output/c.wav'];
const graph=(workflowId:string,maxParallel=2,fail=false)=>({workflowId,maxParallel,pollIntervalMs:50,maxPolls:200,nodes:[
 ...['a','b'].map(id=>({id,args:fail&&id==='a'?['-i','/input/media.raw','-f','invalid','/output/a.wav']:rawArgs(fail&&id==='b'?'failure-peer':id),inputs:[{path:'/input/media.raw',source:{kind:'object' as const,key:'source/media.raw'}}],outputs:[{path:'/output/'+(fail&&id==='b'?'failure-peer':id)+'.wav'}],budget,implementationVersion:'test-v1',maxAttempts:1,leaseMs:2000})),
 {id:'c',args:childArgs,inputs:[{path:'/input/parent.wav',source:{kind:'artifact' as const,nodeId:'a',path:'/output/a.wav'}}],outputs:[{path:'/output/c.wav'}],budget,implementationVersion:'test-v1',maxAttempts:1,leaseMs:2000}
]});
it('runs a persistent bounded media DAG through actual Workflows, Queue, SQLite jobs and immutable R2 artifacts',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-media-workflow-')),root=resolve('tests/workers');
 const bundle=await build({entryPoints:[root+'/media-workflow-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'media-workflow-test',modules:[{type:'ESModule',path:root+'/media-workflow-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:directory,durableObjects:{JOBS:{className:'MediaJobCoordinator',useSQLite:true}},r2Buckets:['MEDIA_BUCKET'],queueProducers:{MEDIA_JOB_QUEUE:'media-workflow-jobs'},queueConsumers:{'media-workflow-jobs':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:1,retryDelay:0}},workflows:{MEDIA_WORKFLOW:{name:'media-workflow-local',className:'MediaWorkflow'}}}));
 let mf=start();
 const call=async<T>(path:string,id:string,body?:object):Promise<T>=>{const response=await mf.dispatchFetch('https://workflow.test/'+path+'?id='+id,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const value=await response.json();expect(response.status,JSON.stringify(value)).toBe(200);return value as T;};
 type Status={status:string;output?:MediaWorkflowManifest;error?:unknown};
 const wait=async(id:string,phase='complete')=>{const end=Date.now()+12000;for(;;){const value=await call<Status>('status',id);if(value.status===phase)return value;if(value.status==='errored'&&phase!=='errored')throw Error(JSON.stringify(value));if(Date.now()>end)throw Error('Workflow timeout '+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,25));}};
 try{
  await mf.ready;let bucket=await mf.getR2Bucket('MEDIA_BUCKET');await bucket.put('source/media.raw',Uint8Array.from({length:1028},(_,i)=>(i*37+11)%256));
  const metrics=async()=>{const rows=[];for(const item of (await bucket.list({prefix:'metrics/'})).objects)rows.push({key:item.key,...await(await bucket.get(item.key))!.json() as {path:string;started:number;ended:number|null}});return rows;};
  const checkBound=async(before:Set<string>,bound:number)=>{const rows=(await metrics()).filter(row=>!before.has(row.key));expect(rows).toHaveLength(3);const events=rows.flatMap(row=>{expect(row.ended).not.toBeNull();return [[row.started,1],[row.ended!,-1]] as const;}).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let live=0,peak=0;for(const [,change]of events){live+=change;peak=Math.max(peak,live);}expect(live).toBe(0);expect(peak).toBeGreaterThan(0);expect(peak).toBeLessThanOrEqual(bound);};
  const created=await call<{spec:MediaWorkflowSpec}>('create','parallel',graph('parallel'));
  let rootsSubmitted=false;const submittedDeadline=Date.now()+2000;while(Date.now()<submittedDeadline){const states=await Promise.all(['a','b'].map(async node=>{const response=await mf.dispatchFetch('https://workflow.test/node-status?id=parallel&node='+node);return await response.json() as MediaJobStatus|null;}));if(states.every(state=>state!==null)&&states.some(state=>state!.phase!=='succeeded')){rootsSubmitted=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}expect(rootsSubmitted).toBe(true);
  const completed=await wait('parallel');await checkBound(new Set(),2);expect(completed.output!.jobCount).toBe(3);
  const manifestObject=await bucket.get(completed.output!.key);expect(manifestObject!.etag).toBe(completed.output!.etag);const manifest=await manifestObject!.json() as MediaWorkflowResult;expect(manifest.graphHash).toBe(created.spec.graphHash);expect(Object.keys(manifest.artifacts).sort()).toEqual(['a','b','c']);
  for(const id of ['a','b']){expect(await call('single','baseline',{args:rawArgs(id)})).toMatchObject({exitCode:0});expect(Buffer.from(await(await bucket.get(manifest.artifacts[id]![0]!.key))!.arrayBuffer())).toEqual(Buffer.from(await(await bucket.get('baseline/'+id+'.wav'))!.arrayBuffer()));}
  const parent=manifest.artifacts.a![0]!;await bucket.put('source/parent.wav',(await bucket.get(parent.key))!.body);expect(await call('single','baseline',{args:childArgs})).toMatchObject({exitCode:0});expect(Buffer.from(await(await bucket.get(manifest.artifacts.c![0]!.key))!.arrayBuffer())).toEqual(Buffer.from(await(await bucket.get('baseline/c.wav'))!.arrayBuffer()));
  const independent=await call<{spec:MediaWorkflowSpec;workUnits:{workUnitId:string;nodeId:string}[]}>('create-independent','independent',{});expect(independent.workUnits).toHaveLength(2);expect(independent.spec.sourceGraphHash).toMatch(/^[a-f0-9]{64}$/);for(const name of ['a','b']){const node=independent.spec.nodes.find(value=>value.outputs[0]!.path==='/output/'+name+'.wav')!;expect(node.args).toEqual(rawArgs(name));}
  const independentDone=await wait('independent'),independentResult=await(await bucket.get(independentDone.output!.key))!.json() as MediaWorkflowResult;
  expect(Object.keys(independentResult.artifacts).sort()).toEqual(['unit-0','unit-1']);
  for(const name of ['a','b']){const artifact=Object.values(independentResult.artifacts).flat().find(value=>value.path==='/output/'+name+'.wav')!;expect(Buffer.from(await(await bucket.get(artifact.key))!.arrayBuffer())).toEqual(Buffer.from(await(await bucket.get('baseline/'+name+'.wav'))!.arrayBuffer()));}
  const repeated=await call<MediaWorkflowManifest>('finalize','parallel',created.spec);expect(repeated).toEqual(completed.output);
  // Workflow step/result persistence is observed after disposing the entire runtime.
  await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');expect((await call<Status>('status','parallel')).output).toEqual(completed.output);
  const childResponse=await mf.dispatchFetch('https://workflow.test/node-status?id=parallel&node=c');const child=await childResponse.json() as MediaJobStatus;expect(child.spec.inputs[0]).toMatchObject({key:parent.key,etag:parent.etag,version:parent.version,size:parent.size});
  // Serial scheduling proves the bound also constrains two initially-ready nodes.
  const beforeSerial=new Set((await metrics()).map(row=>row.key));await call('create','serial',graph('serial',1));await wait('serial');await checkBound(beforeSerial,1);
  await call('create','failed',graph('failed',2,true));await wait('failed','errored');
  expect((await bucket.list({prefix:'workflows/failed/'})).objects).toEqual([]);const failedPeer=await(await mf.dispatchFetch('https://workflow.test/node-status?id=failed&node=b')).json() as MediaJobStatus;expect(failedPeer.phase).toBe('cancelled');expect((await metrics()).some(row=>row.path==='/output/failure-peer.wav')).toBe(false);const unsubmitted=await(await mf.dispatchFetch('https://workflow.test/node-status?id=failed&node=c')).json();expect(unsubmitted).toBeNull();
  expect(await call('cancel-before-submit','tombstone',graph('tombstone'))).toMatchObject({cancelled:{phase:'cancelled'},late:{phase:'cancelled'},claim:null});
  const external=await call<{spec:MediaWorkflowSpec}>('create','cancel-external',graph('cancel-external'));
  const externalDeadline=Date.now()+2000;for(;;){const roots=await Promise.all(['a','b'].map(async node=>await(await mf.dispatchFetch('https://workflow.test/node-status?id=cancel-external&node='+node)).json()));if(roots.every(Boolean))break;if(Date.now()>externalDeadline)throw Error('Cancellation roots not queued');await new Promise(resolve=>setTimeout(resolve,5));}
  expect(await(await mf.dispatchFetch('https://workflow.test/node-claim?id=cancel-external&node=a')).json()).toMatchObject({spec:{workflow:{workflowId:'cancel-external',nodeId:'a'}}});
  const cancelled=await call<{ok:boolean;result:{nodeCount:number;fencedNodeIds:string[];workflowStatus:string}}>('cancel','cancel-external',external.spec);expect(cancelled).toMatchObject({ok:true,result:{nodeCount:3}});expect(cancelled.result.fencedNodeIds.sort()).toEqual(['a','b','c']);
  for(const node of ['a','b'])expect(await(await mf.dispatchFetch('https://workflow.test/node-status?id=cancel-external&node='+node)).json()).toMatchObject({phase:'cancelled'});
  expect(await(await mf.dispatchFetch('https://workflow.test/node-status?id=cancel-external&node=c')).json()).toBeNull();
  expect(await call('cancel','cancel-external',external.spec)).toEqual(cancelled);
  expect(await call('late-submit','cancel-external',{spec:external.spec,nodeId:'a',artifacts:{}})).toMatchObject({status:{phase:'cancelled'},claim:null});
  await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  const lateKey=`jobs/${encodeURIComponent(mediaWorkflowJobId('cancel-external','a'))}/1/late-candidate/parent.wav`,lateObject=await bucket.put(lateKey,(await bucket.get(parent.key))!.body);const lateArtifact={path:'/output/a.wav',key:lateKey,etag:lateObject!.etag,version:lateObject!.version,size:lateObject!.size};
  expect(await call('late-submit','cancel-external',{spec:external.spec,nodeId:'c',artifacts:{a:[lateArtifact]}})).toMatchObject({status:{phase:'cancelled'},claim:null});expect((await bucket.list({prefix:'workflows/cancel-external/'})).objects).toEqual([]);
  const foreign=await call<MediaJobStatus>('prepopulate','conflict',graph('conflict'));await call('create','conflict',graph('conflict'));await wait('conflict','errored');const foreignStatus=await(await mf.dispatchFetch('https://workflow.test/node-status?id=conflict&node=a')).json() as MediaJobStatus;expect(foreignStatus.phase).toBe('queued');expect(foreignStatus.spec).toEqual(foreign.spec);expect((await bucket.list({prefix:'workflows/conflict/'})).objects).toEqual([]);
  const foreignOwner=await call<MediaJobStatus>('prepopulate','cancel-foreign',graph('cancel-foreign'));const cancelForeign=await call<{spec:MediaWorkflowSpec}>('create','cancel-foreign',graph('cancel-foreign'));
  const partial=await call<{ok:boolean;details:{terminationConfirmed:boolean;failures:{nodeId:string}[]}}>('cancel','cancel-foreign',cancelForeign.spec);expect(partial.ok).toBe(false);expect(partial.details.terminationConfirmed).toBe(false);expect(partial.details.failures.some(failure=>failure.nodeId==='a')).toBe(true);
  expect(await(await mf.dispatchFetch('https://workflow.test/node-status?id=cancel-foreign&node=a')).json()).toMatchObject({phase:'queued',spec:foreignOwner.spec});
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},120000);
