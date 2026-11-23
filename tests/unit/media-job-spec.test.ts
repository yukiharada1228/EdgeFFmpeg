import {expect,it} from 'vitest';
import type {R2Bucket} from '@cloudflare/workers-types';
import {buildMediaJobSpec} from '../../packages/runtime-cloudflare/src/jobs/spec.js';
import {snapshotMediaJobSpec} from '../../packages/runtime-cloudflare/src/jobs/state.js';
const budget={maxResidentBytes:1048576,maxBufferBytes:4096,maxCpuTimeMs:1000,maxPendingPackets:8};
function fixture(){let version='v1',reads=0;const bucket={async head(key:string){reads++;return {key,version,etag:'same-content',httpEtag:'"same-content"',size:8,uploaded:new Date(0),storageClass:'Standard',checksums:{toJSON(){return {};}},writeHttpMetadata(){}};}} satisfies Pick<R2Bucket,'head'>;
 const options={bucket,jobId:'job_1',args:['-i','/in.raw','/out.wav'],inputs:[{path:'/in.raw',key:'source/input'}],outputs:[{path:'/out.wav'}],budget,implementationVersion:'backend-pin-1'};return {options,set version(value:string){version=value;},get reads(){return reads;}};}
it('pins every input generation and hashes an immutable whole-command descriptor',async()=>{
 const run=fixture(),a=await buildMediaJobSpec(run.options),b=await buildMediaJobSpec(run.options);
 expect(a).toEqual(b);expect(a.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);expect(a.graphHash).toMatch(/^[0-9a-f]{64}$/);expect(a.inputs[0]).toMatchObject({version:'v1',etag:'same-content',size:8});expect(snapshotMediaJobSpec(a)).toEqual(a);expect(Object.isFrozen(a.inputs[0])).toBe(true);
 run.version='v2';const c=await buildMediaJobSpec(run.options);expect(c.inputFingerprint).not.toBe(a.inputFingerprint);expect(c.graphHash).toBe(a.graphHash);
 const d=await buildMediaJobSpec({...run.options,implementationVersion:'backend-pin-2'});expect(d.graphHash).not.toBe(a.graphHash);
});
it('snapshots arguments and limits before the first provider await',async()=>{
 const run=fixture(),options={...run.options,args:[...run.options.args],budget:{...budget}};
 const pending=buildMediaJobSpec(options);options.args[0]='mutated';options.budget.maxBufferBytes=1;
 const spec=await pending;expect(spec.args[0]).toBe('-i');expect(spec.budget.maxBufferBytes).toBe(4096);
});
it.each(['/../input','//input','/input/','/in\\put','/in\0put'])('rejects invalid virtual paths before contacting storage: %s',async path=>{
 const run=fixture();await expect(buildMediaJobSpec({...run.options,inputs:[{path,key:'source/input'}]})).rejects.toThrow(/paths/);expect(run.reads).toBe(0);
});
it('rejects missing inputs and overlapping paths without constructing a job',async()=>{
 const run=fixture();await expect(buildMediaJobSpec({...run.options,outputs:[{path:'/in.raw'}]})).rejects.toThrow(/paths/);expect(run.reads).toBe(0);
 await expect(buildMediaJobSpec({...run.options,bucket:{async head(){return null;}}})).rejects.toThrow(/does not exist/);
});
it('rejects unbounded arguments and malformed resource policies before storage I/O',async()=>{
 const run=fixture();for(const changed of [{leaseMs:9},{maxAttempts:101},{args:['x'.repeat(4097)]},{budget:{...budget,maxBufferBytes:budget.maxResidentBytes+1}}])await expect(buildMediaJobSpec({...run.options,...changed})).rejects.toThrow();expect(run.reads).toBe(0);
});
