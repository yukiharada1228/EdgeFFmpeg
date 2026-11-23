import {expect,it} from 'vitest';
import type {ExecutionCheckpointIdentity} from '../../packages/core/src/checkpoint.js';
import {cancelMediaCheckpoint,claimMediaCheckpoint,commitMediaCheckpoint,expireMediaCheckpoint,heartbeatMediaCheckpoint,initializeMediaCheckpoint,mediaCheckpointCoordinatorName,mediaCheckpointObjectPrefix,snapshotMediaCheckpointDescriptor,validMediaCheckpointLease} from '../../packages/runtime-cloudflare/src/checkpoints/state.js';
import type {StoredMediaCheckpoint} from '../../packages/runtime-cloudflare/src/checkpoints/state.js';
import type {MediaCheckpointDescriptor,MediaCheckpointLease} from '../../packages/runtime-cloudflare/src/checkpoints/types.js';
const identity:ExecutionCheckpointIdentity={jobId:'journal',workUnitId:'audio:reframe',graphHash:'a'.repeat(64),inputFingerprint:'b'.repeat(64),implementationVersion:'test-v1'};
async function setup(){const name=await mediaCheckpointCoordinatorName(identity),initial=initializeMediaCheckpoint(null,identity,name),claimed=claimMediaCheckpoint(initial,100,1000,'attempt-a');return {name,initial,journal:claimed.journal,lease:claimed.claim!.lease};}
function descriptor(journal:StoredMediaCheckpoint,lease:MediaCheckpointLease,revision=journal.status.revision+1,input=BigInt(journal.status.inputPosition)+192n,bytes=16,finished=false):MediaCheckpointDescriptor{
 const prefix=mediaCheckpointObjectPrefix(journal.namespaceName,lease,revision),object=(suffix:string,size:number)=>({key:prefix+suffix,etag:'etag-'+revision,version:'version-'+revision,size,sha256:'c'.repeat(64)});
 return {identity:{...journal.status.identity},revision,inputPosition:String(input),outputPosition:String(BigInt(journal.status.outputPosition)+BigInt(bytes)),state:object('state.bin',32),output:bytes===0?null:object('output.bin',bytes),finished};
}
it('initializes a stable namespace from job/work unit while enforcing the full immutable identity',async()=>{
 const {name,initial}=await setup();expect(name).toMatch(/^checkpoint-[a-f0-9]{64}$/);expect(initial.status).toMatchObject({identity,phase:'ready',revision:0,inputPosition:'0',outputPosition:'0',lease:null,commits:[]});expect(initializeMediaCheckpoint(initial,{...identity},name)).toBe(initial);
 for(const key of ['jobId','workUnitId','graphHash','inputFingerprint','implementationVersion'] as const){const changed={...identity,[key]:key.endsWith('Hash')||key==='inputFingerprint'?'d'.repeat(64):'different'};expect(()=>initializeMediaCheckpoint(initial,changed,name)).toThrow(/identity/);}
 expect(await mediaCheckpointCoordinatorName({...identity,graphHash:'d'.repeat(64)})).toBe(name);expect(await mediaCheckpointCoordinatorName({...identity,workUnitId:'other'})).not.toBe(name);
});
it('snapshots caller identity and committed descriptors without aliasing previous revisions',async()=>{
 const source={...identity},name=await mediaCheckpointCoordinatorName(source),initial=initializeMediaCheckpoint(null,source,name);source.workUnitId='mutated';expect(initial.status.identity.workUnitId).toBe(identity.workUnitId);
 const {journal,lease}=await setup(),value=descriptor(journal,lease),next=commitMediaCheckpoint(journal,lease,value,1001);Object.assign(value.state,{etag:'mutated'});Object.assign(value,{inputPosition:'999'});expect(next.status.commits[0]!.state.etag).toBe('etag-1');expect(next.status.inputPosition).toBe('192');expect(journal.status.revision).toBe(0);expect(journal.status.commits).toEqual([]);
});
it('claims exclusively, renews from current time, and fences the old generation exactly at expiry',async()=>{
 const {journal,lease}=await setup();expect(claimMediaCheckpoint(journal,100,1001,'busy').claim).toBeNull();const heartbeat=heartbeatMediaCheckpoint(journal,lease,1050);expect(heartbeat.lease?.expiresAt).toBe(1150);expect(validMediaCheckpointLease(heartbeat.journal,lease,1149)).toBe(true);expect(validMediaCheckpointLease(heartbeat.journal,lease,1150)).toBe(false);
 const expired=expireMediaCheckpoint(heartbeat.journal,1150);expect(expired.status.phase).toBe('ready');expect(expired.status.lease).toBeNull();const next=claimMediaCheckpoint(expired,100,1150,'attempt-b');expect(next.claim!.lease.generation).toBe(2);expect(heartbeatMediaCheckpoint(next.journal,lease,1151).lease).toBeNull();expect(()=>commitMediaCheckpoint(next.journal,lease,descriptor(journal,lease),1151)).toThrow(/Stale/);
});
it('atomically advances state, output bytes and sample positions with arbitrary bigint precision',async()=>{
 const {journal,lease}=await setup(),position=10n**35n,next=commitMediaCheckpoint(journal,lease,descriptor(journal,lease,1,position,16),1001);expect(next.status.inputPosition).toBe(String(position));expect(next.status.outputPosition).toBe('16');expect(next.status.commits[0]!.output?.size).toBe(16);expect(next.committers).toEqual([{generation:1,token:'attempt-a'}]);
 const buffered=commitMediaCheckpoint(next,lease,descriptor(next,lease,2,position+1n,0),1002);expect(buffered.status.commits[1]!.output).toBeNull();expect(buffered.status.outputPosition).toBe('16');const flushed=commitMediaCheckpoint(buffered,lease,descriptor(buffered,lease,3,position+1n,8,true),1003);expect(flushed.status.phase).toBe('finished');expect(flushed.status.outputPosition).toBe('24');expect(flushed.status.lease).toBeNull();expect(claimMediaCheckpoint(flushed,100,2000,'late').claim).toBeNull();expect(cancelMediaCheckpoint(flushed)).toBe(flushed);
});
it('accepts empty EOF but rejects nonfinished zero progress',async()=>{const {journal,lease}=await setup();expect(()=>commitMediaCheckpoint(journal,lease,descriptor(journal,lease,1,0n,0),1001)).toThrow(/advance/);const done=commitMediaCheckpoint(journal,lease,descriptor(journal,lease,1,0n,0,true),1001);expect(done.status.phase).toBe('finished');expect(done.status.commits[0]!.output).toBeNull();});
it('reconciles an exact original acknowledgement after expiry and a newer owner commit without rolling back',async()=>{
 const {journal,lease}=await setup(),first=descriptor(journal,lease),one=commitMediaCheckpoint(journal,lease,first,1001),claimed=claimMediaCheckpoint(one,100,1100,'attempt-b'),second=descriptor(claimed.journal,claimed.claim!.lease),two=commitMediaCheckpoint(claimed.journal,claimed.claim!.lease,second,1101);
 expect(commitMediaCheckpoint(two,lease,first,9999)).toBe(two);expect(two.status.revision).toBe(2);expect(two.status.lease?.token).toBe('attempt-b');expect(()=>commitMediaCheckpoint(two,lease,{...first,inputPosition:'193'},1102)).toThrow(/conflict/);expect(()=>commitMediaCheckpoint(two,claimed.claim!.lease,first,1102)).toThrow(/committer/);
});
it('cancel fences all new commits/claims while allowing original exact commit acknowledgement reconciliation',async()=>{
 const {journal,lease}=await setup(),first=descriptor(journal,lease),one=commitMediaCheckpoint(journal,lease,first,1001),cancelled=cancelMediaCheckpoint(one);expect(cancelled.status.phase).toBe('cancelled');expect(cancelMediaCheckpoint(cancelled)).toBe(cancelled);expect(claimMediaCheckpoint(cancelled,100,1100,'late').claim).toBeNull();expect(()=>commitMediaCheckpoint(cancelled,lease,descriptor(one,lease),1002)).toThrow(/Stale/);expect(commitMediaCheckpoint(cancelled,lease,first,1002)).toBe(cancelled);
});
it('rejects gaps, backwards positions, mismatched byte deltas and non-null empty output atomically',async()=>{
 const {journal,lease}=await setup(),one=commitMediaCheckpoint(journal,lease,descriptor(journal,lease),1001),good=descriptor(one,lease);
 const invalids:MediaCheckpointDescriptor[]=[{...good,revision:3},{...good,inputPosition:'191'},{...good,outputPosition:'15'},{...good,output:null},{...good,output:good.output&&{...good.output,size:17}},{...good,outputPosition:'16'}];
 for(const value of invalids)expect(()=>commitMediaCheckpoint(one,lease,value,1002)).toThrow();expect(one.status.revision).toBe(1);expect(one.status.commits).toHaveLength(1);
});
it('requires both objects to belong to the exact lease and revision rather than a public mutable key',async()=>{
 const {journal,lease}=await setup(),good=descriptor(journal,lease);for(const key of ['public/output.bin',good.state.key.replace('/1/','/2/'),good.state.key.replace('/attempt-a/','/attempt-b/'),good.state.key.replace('revision-1','revision-2')])expect(()=>commitMediaCheckpoint(journal,lease,{...good,state:{...good.state,key}},1001)).toThrow(/owned/);
 expect(()=>commitMediaCheckpoint(journal,lease,{...good,output:good.output&&{...good.output,key:good.state.key}},1001)).toThrow(/owned/);
});
it('bounds the journal at 256 immutable commits and preserves the final valid revision',async()=>{
 const run=await setup();let journal=run.journal;for(let revision=1;revision<=256;revision++)journal=commitMediaCheckpoint(journal,run.lease,descriptor(journal,run.lease,revision,BigInt(revision),0),1001);expect(journal.status.commits).toHaveLength(256);expect(()=>commitMediaCheckpoint(journal,run.lease,{...journal.status.commits[255]!,revision:257,inputPosition:'257'},1002)).toThrow();expect(journal.status.revision).toBe(256);
});
it.each(['-1','01','1.0','1e3','', '9'.repeat(129)])('rejects noncanonical or oversized sample/byte position %s',async value=>{const {journal,lease}=await setup(),good=descriptor(journal,lease);expect(()=>snapshotMediaCheckpointDescriptor({...good,inputPosition:value})).toThrow(/position/);expect(()=>snapshotMediaCheckpointDescriptor({...good,outputPosition:value})).toThrow(/position/);});
it.each([{sha256:'G'.repeat(64)},{sha256:'a'.repeat(63)},{version:''},{etag:''},{size:0},{size:67108865},{key:'../state.bin'},{key:'a//b'},{key:'/state.bin'},{key:'a\\b'}])('rejects malformed object metadata %j',async patch=>{const {journal,lease}=await setup(),good=descriptor(journal,lease);expect(()=>snapshotMediaCheckpointDescriptor({...good,state:{...good.state,...patch}})).toThrow(/object/);});
it.each([0,9,300001,1.5,NaN,Infinity])('rejects invalid lease duration %s',async duration=>{const {initial}=await setup();expect(()=>claimMediaCheckpoint(initial,duration,1000,'valid')).toThrow(/lease/);});
it('rejects malformed identity, namespace, lease token and revision ownership',async()=>{
 const {initial,name,lease}=await setup();expect(()=>initializeMediaCheckpoint(null,{...identity,graphHash:'bad'},name)).toThrow();expect(()=>initializeMediaCheckpoint(null,identity,'foreign')).toThrow();expect(()=>claimMediaCheckpoint(initial,100,1000,'../escape')).toThrow();expect(()=>mediaCheckpointObjectPrefix(name,{...lease,token:'../escape'},1)).toThrow();expect(()=>mediaCheckpointObjectPrefix(name,lease,257)).toThrow();
});

it.each(['graphHash','inputFingerprint','implementationVersion'] as const)('rejects a descriptor bound to a different %s before any journal publication',async key=>{
 const {journal,lease}=await setup(),good=descriptor(journal,lease),foreign={...good,identity:{...good.identity,[key]:key==='implementationVersion'?'different-implementation':'d'.repeat(64)}};
 expect(()=>commitMediaCheckpoint(journal,lease,foreign,1001)).toThrow(/identity mismatch/);expect(journal.status.revision).toBe(0);expect(journal.status.commits).toEqual([]);expect(journal.committers).toEqual([]);
 const one=commitMediaCheckpoint(journal,lease,good,1001),claimed=claimMediaCheckpoint(one,100,1100,'attempt-b'),two=commitMediaCheckpoint(claimed.journal,claimed.claim!.lease,descriptor(claimed.journal,claimed.claim!.lease),1101);
 expect(()=>commitMediaCheckpoint(two,lease,foreign,9999)).toThrow(/identity mismatch/);expect(commitMediaCheckpoint(two,lease,good,9999)).toBe(two);expect(two.status.revision).toBe(2);expect(two.status.lease?.token).toBe('attempt-b');
});
it('snapshots descriptor identity so caller mutation cannot rewrite a committed compatibility boundary',async()=>{
 const {journal,lease}=await setup(),good=descriptor(journal,lease),one=commitMediaCheckpoint(journal,lease,good,1001);Object.assign(good.identity,{graphHash:'d'.repeat(64),inputFingerprint:'e'.repeat(64),implementationVersion:'mutated'});expect(one.status.commits[0]!.identity).toEqual(identity);expect(one.status.identity).toEqual(identity);
});
