import {expect,it} from 'vitest';
import type {MediaJobSpec,MediaJobWorkflowIdentity} from '../../packages/runtime-cloudflare/src/jobs/types.js';
import {cancelMediaJobWorkflow,claimMediaJob,mediaJobWorkflowId,snapshotMediaJobSpec,snapshotMediaJobWorkflowIdentity,submitFencedMediaJob,submitMediaJob,succeedMediaJob} from '../../packages/runtime-cloudflare/src/jobs/state.js';
import {mediaJobArtifactPrefix} from '../../packages/runtime-cloudflare/src/jobs/types.js';

const owner:MediaJobWorkflowIdentity={workflowId:'pipeline',graphHash:'a'.repeat(64),nodeId:'child'};
const spec:MediaJobSpec={version:1,jobId:mediaJobWorkflowId(owner),workflow:owner,workUnitId:'command',graphHash:'b'.repeat(64),inputFingerprint:'c'.repeat(64),implementationVersion:'test',args:['-i','/in','/out'],inputs:[{path:'/in',key:'jobs/parent/1/token/out',etag:'parent-etag',version:'parent-version',size:16}],outputs:[{path:'/out'}],budget:{maxResidentBytes:1024,maxBufferBytes:512,maxCpuTimeMs:1000,maxPendingPackets:1},maxAttempts:2,leaseMs:100};
it('persists ownership before future parent input pins exist and cancels late matching submission',()=>{
 const cancelled=cancelMediaJobWorkflow(null,owner,null);
 expect(cancelled.job).toBeNull();expect(cancelled.fence).toEqual(owner);
 const persisted=JSON.parse(JSON.stringify(cancelled.fence)) as MediaJobWorkflowIdentity;
 const late=submitFencedMediaJob(null,spec,1000,persisted);
 expect(late.status.phase).toBe('cancelled');expect(late.nextDispatchAt).toBeNull();expect(claimMediaJob(late,1001,'late-token').claim).toBeNull();
 expect(submitFencedMediaJob(late,spec,1002,persisted)).toBe(late);
});
it('rejects foreign workflow identity and unowned late submissions without altering the fence',()=>{
 const fence=cancelMediaJobWorkflow(null,owner,null).fence;
 expect(()=>submitFencedMediaJob(null,{...spec,workflow:{...owner,graphHash:'d'.repeat(64)}},1000,fence)).toThrow(/ownership conflict/);
 const {workflow:unused,...unowned}=spec;expect(unused).toEqual(owner);
 expect(()=>submitFencedMediaJob(null,unowned,1000,fence)).toThrow(/ownership conflict/);
 expect(()=>cancelMediaJobWorkflow(null,{...owner,graphHash:'d'.repeat(64)},fence)).toThrow(/ownership conflict/);
 expect(fence).toEqual(owner);
});
it('preserves existing foreign or unowned jobs when cancellation ownership conflicts',()=>{
 const foreign=submitMediaJob(null,{...spec,workflow:{...owner,graphHash:'d'.repeat(64)}},1000);
 expect(()=>cancelMediaJobWorkflow(foreign,owner,null)).toThrow(/ownership conflict/);expect(foreign.status.phase).toBe('queued');
 const {workflow:unused,...unowned}=spec;expect(unused).toEqual(owner);
 const standalone=submitMediaJob(null,unowned,1000);
 expect(()=>cancelMediaJobWorkflow(standalone,owner,null)).toThrow(/ownership conflict/);expect(standalone.nextDispatchAt).toBe(1000);
});
it('fences an active matching lease and preserves already successful immutable artifacts',()=>{
 const claimed=claimMediaJob(submitMediaJob(null,spec,1000),1000,'token');
 const cancelled=cancelMediaJobWorkflow(claimed.job,owner,null);
 expect(cancelled.job?.status.phase).toBe('cancelled');expect(cancelled.job?.status.lease).toBeNull();
 const artifact={path:'/out',key:mediaJobArtifactPrefix(spec.jobId,claimed.claim!.lease)+'result',etag:'etag',version:'version',size:32};
 const success=succeedMediaJob(claimed.job,claimed.claim!.lease,[artifact],1001);
 const fenced=cancelMediaJobWorkflow(success,owner,null);
 expect(fenced.job).toBe(success);expect(fenced.job?.status.artifacts).toEqual([artifact]);expect(fenced.fence).toEqual(owner);
});
it('includes ownership in immutable spec identity and enforces deterministic job namespace',()=>{
 const normalized=snapshotMediaJobSpec(spec);expect(normalized.workflow).toEqual(owner);expect(normalized.workflow).not.toBe(owner);
 expect(()=>snapshotMediaJobSpec({...spec,jobId:'foreign-job'})).toThrow(/workflow namespace/);
 expect(()=>submitMediaJob(submitMediaJob(null,spec,1000),{...spec,workflow:{...owner,graphHash:'d'.repeat(64)}},1001)).toThrow(/immutable spec conflict/);
});
it.each([{...owner,workflowId:'-invalid'},{...owner,nodeId:'bad/name'},{...owner,graphHash:'unpinned'}])('rejects malformed workflow ownership: %j',identity=>{
 expect(()=>snapshotMediaJobWorkflowIdentity(identity)).toThrow(/workflow identity/);
});
