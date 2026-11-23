import {expect,it} from 'vitest';
import type {MediaJobArtifact,MediaJobSpec} from '../../packages/runtime-cloudflare/src/jobs/types.js';
import {mediaJobArtifactPrefix} from '../../packages/runtime-cloudflare/src/jobs/types.js';
import {cancelMediaJob,claimMediaJob,expireMediaJob,failMediaJob,heartbeatMediaJob,snapshotMediaJobSpec,submitMediaJob,succeedMediaJob,validMediaJobLease} from '../../packages/runtime-cloudflare/src/jobs/state.js';

const spec:MediaJobSpec={version:1,jobId:'test_job',workUnitId:'command',graphHash:'a'.repeat(64),inputFingerprint:'b'.repeat(64),implementationVersion:'test',args:['-i','/in','/out'],inputs:[{path:'/in',key:'inputs/file',etag:'input-etag',version:'input-version',size:16}],outputs:[{path:'/out'}],budget:{maxResidentBytes:1024,maxBufferBytes:512,maxCpuTimeMs:1000,maxPendingPackets:1},maxAttempts:2,leaseMs:100};
function running(){return claimMediaJob(submitMediaJob(null,spec,1000),1000,'token-1');}
function artifact(lease=running().claim!.lease):MediaJobArtifact{return {path:'/out',key:mediaJobArtifactPrefix(spec.jobId,lease)+'output',etag:'output-etag',version:'output-version',size:24};}
it('snapshots immutable specs and treats matching submission as idempotent across JSON persistence',()=>{
 const first=submitMediaJob(null,spec,1000);
 const restored=JSON.parse(JSON.stringify(first)) as typeof first;
 expect(submitMediaJob(restored,{...spec,budget:{maxPendingPackets:1,maxCpuTimeMs:1000,maxBufferBytes:512,maxResidentBytes:1024}},2000)).toEqual(first);
 expect(first.status.spec).not.toBe(spec);expect(first.status.spec.args).not.toBe(spec.args);
 expect(()=>submitMediaJob(restored,{...spec,args:['different']},2000)).toThrow(/immutable spec conflict/);
});
it('fences duplicate claims, expiry and replacement generations',()=>{
 const first=running(),old=first.claim!.lease;
 expect(claimMediaJob(first.job,1001,'duplicate').claim).toBeNull();
 expect(validMediaJobLease(first.job,old,1099)).toBe(true);expect(validMediaJobLease(first.job,old,1100)).toBe(false);
 const replacement=claimMediaJob(first.job,1100,'token-2');
 expect(replacement.claim!.lease.generation).toBe(2);expect(replacement.job.status.attempts).toBe(2);
 expect(()=>succeedMediaJob(replacement.job,old,[artifact(old)],1101)).toThrow(/Stale/);
 expect(()=>failMediaJob(replacement.job,old,'late failure',false,1101)).toThrow(/Stale/);
});
it('renews only the current unexpired lease and keeps the durable deadline aligned',()=>{
 const run=running(),lease=run.claim!.lease;
 const renewed=heartbeatMediaJob(run.job,lease,1050);
 expect(renewed.lease?.expiresAt).toBe(1150);expect(renewed.job.nextDispatchAt).toBe(1150);
 expect(heartbeatMediaJob(run.job,{...lease,token:'wrong'},1050).lease).toBeNull();
 expect(heartbeatMediaJob(run.job,lease,1100).job.status.phase).toBe('queued');
});
it('cancellation immediately fences late success and remains terminal across retry delivery',()=>{
 const run=running(),cancelled=cancelMediaJob(run.job);
 expect(cancelled.nextDispatchAt).toBeNull();expect(cancelled.status.phase).toBe('cancelled');
 expect(validMediaJobLease(cancelled,run.claim!.lease,1001)).toBe(false);
 expect(()=>succeedMediaJob(cancelled,run.claim!.lease,[artifact()],1001)).toThrow(/Stale/);
 expect(claimMediaJob(cancelled,1002,'retry').claim).toBeNull();expect(cancelMediaJob(cancelled)).toBe(cancelled);
});
it('publishes one immutable artifact pointer and accepts only exactly idempotent finalization',()=>{
 const run=running(),lease=run.claim!.lease,candidate=artifact(lease);
 const done=succeedMediaJob(run.job,lease,[candidate],1001);
 expect(done.status.artifacts).toEqual([candidate]);expect(done.status.phase).toBe('succeeded');expect(done.nextDispatchAt).toBeNull();
 expect(succeedMediaJob(done,lease,[candidate],2000)).toBe(done);
 expect(()=>succeedMediaJob(done,lease,[{...candidate,etag:'changed'}],2000)).toThrow(/finalization conflict/);
 expect(()=>succeedMediaJob(done,{...lease,token:'other'},[{...candidate,key:mediaJobArtifactPrefix(spec.jobId,{...lease,token:'other'})+'out'}],1001)).toThrow(/Stale/);
});
it.each(['public/out','jobs/test_job/0/old/out'])('rejects artifact keys outside the current immutable attempt: %s',key=>{
 const run=running();expect(()=>succeedMediaJob(run.job,run.claim!.lease,[{...artifact(),key}],1001)).toThrow(/immutable/);
});
it('rejects missing, duplicate or unknown artifact output paths',()=>{
 const run=running(),lease=run.claim!.lease;
 expect(()=>succeedMediaJob(run.job,lease,[],1001)).toThrow(/count/);
 expect(()=>succeedMediaJob(run.job,lease,[{...artifact(),path:'/other'}],1001)).toThrow(/immutable/);
});
it('retries whole commands within attempt budget and makes exhaustion terminal',()=>{
 const first=running(),failed=failMediaJob(first.job,first.claim!.lease,'retryable',true,1001);
 expect(failed.status.phase).toBe('queued');expect(failed.nextDispatchAt).toBe(1001);
 const second=claimMediaJob(failed,1002,'token-2');
 expect(failMediaJob(second.job,second.claim!.lease,'again',true,1003).status.phase).toBe('failed');
 expect(expireMediaJob(second.job,1102).status.phase).toBe('failed');
 expect(failMediaJob(first.job,first.claim!.lease,'fatal',false,1001).nextDispatchAt).toBeNull();
});
it.each([
 {leaseMs:9},{leaseMs:300001},{maxAttempts:0},{graphHash:'unpinned'},
 {inputs:[{...spec.inputs[0]!,path:'/a/../in'}]},
 {inputs:[{...spec.inputs[0]!,key:'../mutable'}]},
 {outputs:[{path:'/in'}]},
 {budget:{...spec.budget,maxBufferBytes:2048}}
])('rejects malformed job specifications before persistence: %j',override=>{
 expect(()=>snapshotMediaJobSpec({...spec,...override})).toThrow(/Invalid/);
});
it('preserves empty argument values but rejects NUL and excessive UTF-8 argument bytes',()=>{
 expect(snapshotMediaJobSpec({...spec,args:['-metadata','title=','']} ).args.at(-1)).toBe('');
 expect(()=>snapshotMediaJobSpec({...spec,args:['bad\0argument']})).toThrow(/arguments/);
 expect(()=>snapshotMediaJobSpec({...spec,args:Array.from({length:6},()=> '界'.repeat(4000))})).toThrow(/arguments/);
});
it.each(['/input\0hidden','/input//file','/input/./file','/input\\file'])('rejects noncanonical input paths: %s',path=>{
 expect(()=>snapshotMediaJobSpec({...spec,inputs:[{...spec.inputs[0]!,path}]})).toThrow(/input/);
});

it('orders artifact paths by fixed code units independently of locale',()=>{
 const paths=['/é','/a','/あ','/Z'];
 const job=claimMediaJob(submitMediaJob(null,{...spec,outputs:paths.map(path=>({path}))},1000),1000,'unicode-token');
 const lease=job.claim!.lease;
 const artifacts=paths.map((path,index)=>({...artifact(lease),path,key:mediaJobArtifactPrefix(spec.jobId,lease)+'output-'+index}));
 const done=succeedMediaJob(job.job,lease,artifacts,1001);
 expect(done.status.artifacts.map(value=>value.path)).toEqual(['/Z','/a','/é','/あ']);
 expect(succeedMediaJob(done,lease,[...artifacts].reverse(),1002)).toEqual(done);
});
