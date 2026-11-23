import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import type {R2Bucket} from '@cloudflare/workers-types';
import type {MediaJobCoordinatorClient,MediaJobSpec} from '../../packages/runtime-cloudflare/src/jobs/types.js';
import {executeMediaJob,runMediaJob,consumeMediaJobs} from '../../packages/runtime-cloudflare/src/jobs/executor.js';
import {submitMediaJob,claimMediaJob,heartbeatMediaJob,validMediaJobLease,succeedMediaJob,failMediaJob,cancelMediaJob} from '../../packages/runtime-cloudflare/src/jobs/state.js';
import type {StoredMediaJob} from '../../packages/runtime-cloudflare/src/jobs/state.js';

const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-11-18',r2Buckets:['BUCKET']}));
let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>;
beforeAll(async()=>{await mf.ready;bucket=await mf.getR2Bucket('BUCKET');});
afterAll(async()=>{await mf.dispose();});
let sequence=0;
async function setup(maxAttempts=1,maxResidentBytes=8388608){
 const jobId=`executor-${sequence++}`,key=`input/${jobId}`;const input=await bucket.put(key,new Uint8Array([1,2,3]));
 if(!input)throw Error('Fixture input write failed');
 const spec:MediaJobSpec={version:1,jobId,workUnitId:'command',graphHash:'a'.repeat(64),inputFingerprint:'b'.repeat(64),implementationVersion:'test-v1',args:['-i','/in','-f','data','/out'],inputs:[{path:'/in',key,etag:input.etag,version:input.version,size:3}],outputs:[{path:'/out'}],budget:{maxResidentBytes,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:5000},maxAttempts,leaseMs:1000};
 let job:StoredMediaJob=submitMediaJob(null,spec,Date.now());
 const coordinator:MediaJobCoordinatorClient={async submit(next){job=submitMediaJob(job,next,Date.now());return job.status;},async claim(){const result=claimMediaJob(job,Date.now(),crypto.randomUUID());job=result.job;return result.claim;},async heartbeat(lease){const result=heartbeatMediaJob(job,lease,Date.now());job=result.job;return result.lease;},async check(lease){return validMediaJobLease(job,lease,Date.now());},async status(){return job.status;},async cancel(){job=cancelMediaJob(job);return job.status;},async succeed(lease,artifacts){job=succeedMediaJob(job,lease,artifacts,Date.now());return job.status;},async fail(lease,error,options){job=failMediaJob(job,lease,error,options.retryable,Date.now());return job.status;}};
 const backend:ExecutionBackend={async execute(_command,context){const reader=await context.filesystem.openRead('/in'),bytes=await reader.readAt(0n,3,context.signal),writer=await context.filesystem.openWrite('/out',{overwrite:true});try{await writer.write(bytes);await writer.commit();return ['/out'];}catch(error){await writer.abort(error);throw error;}}};
 // Miniflare bridges Headers/Streams into Node; the underlying R2 operations
 // here are the same Worker binding operations exercised by the runner.
 const options={bucket:bucket as R2Bucket & typeof bucket,backend:()=>backend,implementationVersion:'test-v1',coordinatorFor:()=>coordinator};
 return {spec,coordinator,backend,options};
}

it('runs actual FFmpeg with pinned R2 input and an immutable lease output pointer',async()=>{
 const run=await setup(),result=await runMediaJob(run.spec.jobId,run.options);expect(result.kind).toBe('terminal');expect(result.status?.phase,result.status?.error??'').toBe('succeeded');
 const artifact=result.status!.artifacts[0]!;expect(artifact.key).toMatch(new RegExp(`^jobs/${run.spec.jobId}/1/[^/]+/output-0$`));expect(artifact.version).not.toBe('');expect(artifact.size).toBe(3);expect(new Uint8Array(await (await bucket.get(artifact.key))!.arrayBuffer())).toEqual(new Uint8Array([1,2,3]));expect(await bucket.head('/out')).toBeNull();
 const duplicate=await runMediaJob(run.spec.jobId,run.options);expect(duplicate.status?.artifacts).toEqual(result.status?.artifacts);
});

it('rejects an input replacement with identical bytes and etag but a new version',async()=>{
 const run=await setup();await bucket.put(run.spec.inputs[0]!.key,new Uint8Array([1,2,3]));
 const backend=vi.fn(()=>run.backend),result=await runMediaJob(run.spec.jobId,{...run.options,backend});expect(result.status?.phase).toBe('failed');expect(result.status?.error).toMatch(/generation changed/);expect(backend).not.toHaveBeenCalled();expect(result.status?.artifacts).toEqual([]);
});

it('rejects implementation mismatch before invoking a backend',async()=>{
 const run=await setup(),backend=vi.fn(()=>run.backend);const result=await runMediaJob(run.spec.jobId,{...run.options,implementationVersion:'different',backend});expect(result.status?.phase).toBe('failed');expect(result.status?.error).toMatch(/version mismatch/);expect(backend).not.toHaveBeenCalled();
});

it('reserves a conservative R2 buffer envelope before supplying the media budget',async()=>{
 const run=await setup();let remaining=0;
 const backend:ExecutionBackend={async execute(command,context){remaining=context.budget.maxResidentBytes;return run.backend.execute(command,context);}};
 expect((await runMediaJob(run.spec.jobId,{...run.options,backend:()=>backend})).status?.phase).toBe('succeeded');
 expect(remaining).toBe(run.spec.budget.maxResidentBytes-5242880-4096-65536-65536);
});

it('rejects insufficient I/O budget before constructing a backend or writing artifacts',async()=>{
 const run=await setup(1,1048576),backend=vi.fn(()=>run.backend);
 const result=await runMediaJob(run.spec.jobId,{...run.options,backend});expect(result.status?.phase).toBe('failed');expect(result.status?.error).toMatch(/budget.*R2 I\/O/);expect(backend).not.toHaveBeenCalled();expect((await bucket.list({prefix:`jobs/${run.spec.jobId}/`})).objects).toEqual([]);
});

it.each([0,-1,NaN,1.5])('rejects invalid read limits before constructing a backend: %s',async maxReadBytes=>{
 const run=await setup(),backend=vi.fn(()=>run.backend),result=await runMediaJob(run.spec.jobId,{...run.options,backend,maxReadBytes});expect(result.status?.error).toMatch(/I\/O limits/);expect(backend).not.toHaveBeenCalled();
});

it('rechecks unconsumed input pins before publishing the coordinator pointer',async()=>{
 const run=await setup();const backend:ExecutionBackend={async execute(_command,context){const writer=await context.filesystem.openWrite('/out');await writer.write(new Uint8Array([9]));await writer.commit();await bucket.put(run.spec.inputs[0]!.key,new Uint8Array([1,2,3]));return ['/out'];}};
 const result=await runMediaJob(run.spec.jobId,{...run.options,backend:()=>backend});expect(result.status?.phase).toBe('failed');expect(result.status?.artifacts).toEqual([]);expect(result.status?.error).toMatch(/generation changed/);
});

it('fences cancelled leases before committing the private output',async()=>{
 const run=await setup();const backend:ExecutionBackend={async execute(_command,context){const writer=await context.filesystem.openWrite('/out');await writer.write(new Uint8Array([9]));await run.coordinator.cancel();try{await writer.commit();return ['/out'];}catch(error){await writer.abort(error);throw error;}}};
 expect((await runMediaJob(run.spec.jobId,{...run.options,backend:()=>backend})).kind).toBe('terminal');expect((await run.coordinator.status())?.phase).toBe('cancelled');expect((await bucket.list({prefix:`jobs/${run.spec.jobId}/`})).objects).toEqual([]);
});

it('releases failed execution for a complete-command retry with a new lease',async()=>{
 const run=await setup(2),backend:ExecutionBackend={async execute(){throw Error('transient runner failure');}};
 const failed=await runMediaJob(run.spec.jobId,{...run.options,backend:()=>backend});expect(failed.kind).toBe('retry');expect(failed.status?.phase).toBe('queued');
 const next=await runMediaJob(run.spec.jobId,run.options);expect(next.status?.phase).toBe('succeeded');expect(next.status?.generation).toBe(2);
});

it('renews a running lease and propagates renewal loss to cooperative execution',async()=>{
 const run=await setup();const claim=(await run.coordinator.claim())!;let renewals=0;
 const coordinator={...run.coordinator,async heartbeat(){renewals++;return null;}};
 const backend:ExecutionBackend={async execute(_command,context){await new Promise<void>((resolve)=>context.signal.addEventListener('abort',()=>resolve(),{once:true}));context.signal.throwIfAborted();return [];}};
 const result=await executeMediaJob({...run.options,coordinator,spec:run.spec,lease:claim.lease,backend:()=>backend});expect(renewals).toBe(1);expect(result.status?.phase).toBe('failed');expect(result.status?.error).toMatch(/renewal rejected/);
});

it('keeps a committed success artifact after a lost completion RPC response',async()=>{
 const run=await setup(),coordinator={...run.coordinator,async succeed(...args:Parameters<MediaJobCoordinatorClient['succeed']>){await run.coordinator.succeed(...args);throw Error('lost success reply');}};
 expect((await runMediaJob(run.spec.jobId,{...run.options,coordinatorFor:()=>coordinator})).kind).toBe('terminal');
 const status=(await run.coordinator.status())!;expect(status.phase).toBe('succeeded');expect(await bucket.head(status.artifacts[0]!.key)).not.toBeNull();expect((await runMediaJob(run.spec.jobId,run.options)).kind).toBe('terminal');
});

it('acknowledges terminal queue messages and retries an active duplicate lease',async()=>{
 const done=await setup();await runMediaJob(done.spec.jobId,done.options);const busy=await setup();await busy.coordinator.claim();
 const completed={body:{jobId:done.spec.jobId},ack:vi.fn(),retry:vi.fn(),id:'complete',attempts:1,timestamp:new Date()},running={...completed,body:{jobId:busy.spec.jobId},ack:vi.fn(),retry:vi.fn(),id:'running'};
 await consumeMediaJobs({messages:[completed,running]},{...done.options,coordinatorFor:id=>id===done.spec.jobId?done.coordinator:busy.coordinator});expect(completed.ack).toHaveBeenCalledOnce();expect(completed.retry).not.toHaveBeenCalled();expect(running.retry).toHaveBeenCalledWith({delaySeconds:1});expect(running.ack).not.toHaveBeenCalled();
});
