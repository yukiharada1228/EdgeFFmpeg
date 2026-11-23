import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import type {MediaJobArtifact} from '../../packages/runtime-cloudflare/src/jobs/types.js';
import type {MediaWorkflowNode,MediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-types.js';
import {deriveMediaJobSpec,hashMediaWorkflowSpec,mediaWorkflowJobId,readyMediaWorkflowNodes,validateMediaWorkflowSpec,verifyMediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-plan.js';

const budget={maxResidentBytes:1024,maxBufferBytes:512,maxCpuTimeMs:1000,maxPendingPackets:1};
const node=(id:string,parent?:string):MediaWorkflowNode=>({id,args:['-i','/in','/out'],inputs:[{path:'/in',source:parent?{kind:'artifact',nodeId:parent,path:'/out'}:{kind:'object',key:'input/source',etag:'etag',version:'version',size:8}}],outputs:[{path:'/out'}],budget,implementationVersion:'test',maxAttempts:2,leaseMs:100});
function spec():MediaWorkflowSpec{return {version:1,workflowId:'fork',graphHash:'0'.repeat(64),nodes:[node('source'),node('left','source'),node('right','source')],maxParallel:2,pollIntervalMs:50,maxPolls:20};}
async function signed(){const value=spec();return {...value,graphHash:await hashMediaWorkflowSpec(value)};}
const parentArtifact=(workflowId='fork'):MediaJobArtifact=>({path:'/out',key:`jobs/${mediaWorkflowJobId(workflowId,'source')}/1/token/out`,etag:'parent-etag',version:'parent-version',size:16});
it('snapshots every descriptor and derives a deterministic hash excluding only graphHash',async()=>{
 const input=spec(),snapshot=validateMediaWorkflowSpec(input);
 expect(snapshot).not.toBe(input);expect(snapshot.nodes[0]!.budget).not.toBe(input.nodes[0]!.budget);expect(snapshot.nodes[0]!.inputs[0]!.source).not.toBe(input.nodes[0]!.inputs[0]!.source);
 expect(await hashMediaWorkflowSpec(input)).toBe(await hashMediaWorkflowSpec({...input,graphHash:'f'.repeat(64)}));
 const pinned=await signed();expect(await verifyMediaWorkflowSpec(pinned)).toEqual(pinned);
 await expect(verifyMediaWorkflowSpec({...pinned,maxParallel:1})).rejects.toThrow(/hash mismatch/);
});
it('changes graph identity when input versions, retry policy or implementation changes',async()=>{
 const original=spec(),hash=await hashMediaWorkflowSpec(original);
 for(const changed of [
  {...original,maxPolls:21},
  {...original,nodes:[{...original.nodes[0]!,implementationVersion:'new'},...original.nodes.slice(1)]},
  {...original,nodes:[{...original.nodes[0]!,maxAttempts:3},...original.nodes.slice(1)]},
  {...original,nodes:[{...original.nodes[0]!,inputs:[{path:'/in',source:{kind:'object' as const,key:'input/source',etag:'etag',version:'new-version',size:8}}]},...original.nodes.slice(1)]}
 ])expect(await hashMediaWorkflowSpec(changed)).not.toBe(hash);
});
it('uses injective bounded workflow/node job identities',()=>{
 expect(mediaWorkflowJobId('a','b-c')).not.toBe(mediaWorkflowJobId('a-b','c'));
 expect(mediaWorkflowJobId('a'.repeat(64),'b'.repeat(48)).length).toBeLessThanOrEqual(128);
 expect(()=>mediaWorkflowJobId('bad/name','node')).toThrow(/identity/);
 expect(()=>mediaWorkflowJobId('-leading-hyphen','node')).toThrow(/identity/);
});
it('schedules dependencies in stable declared order and obeys the active parallel bound',()=>{
 const workflow=spec();
 expect(readyMediaWorkflowNodes(workflow,new Set(),new Set()).map(node=>node.id)).toEqual(['source']);
 expect(readyMediaWorkflowNodes(workflow,new Set(['source']),new Set()).map(node=>node.id)).toEqual(['left','right']);
 expect(readyMediaWorkflowNodes(workflow,new Set(['source']),new Set(['left'])).map(node=>node.id)).toEqual(['right']);
 expect(readyMediaWorkflowNodes(workflow,new Set(['source']),new Set(['left','right']))).toEqual([]);
 expect(()=>readyMediaWorkflowNodes(workflow,new Set(['missing']),new Set())).toThrow(/Unknown/);
 expect(()=>readyMediaWorkflowNodes(workflow,new Set(['source']),new Set(['source']))).toThrow(/running and completed/);
});
it('validates forward references while rejecting cycles, missing parents and undeclared artifact paths',()=>{
 const workflow=spec();expect(()=>validateMediaWorkflowSpec({...workflow,nodes:[...workflow.nodes].reverse()})).not.toThrow();
 expect(()=>validateMediaWorkflowSpec({...workflow,nodes:[node('source','right'),node('right','source')]})).toThrow(/Cyclic/);
 expect(()=>validateMediaWorkflowSpec({...workflow,nodes:[node('child','missing')]})).toThrow(/Missing/);
 expect(()=>validateMediaWorkflowSpec({...workflow,nodes:[node('source'),{...node('child','source'),inputs:[{path:'/in',source:{kind:'artifact',nodeId:'source',path:'/undeclared'}}]}]})).toThrow(/artifact output/);
});
it.each([
 {workflowId:'-leading-hyphen'},{maxParallel:0},{maxParallel:17},{pollIntervalMs:49},{pollIntervalMs:60001},{maxPolls:0},{maxPolls:257},{workflowId:'bad/path'},
 {nodes:[node('duplicate'),node('duplicate')]},
 {nodes:[{...node('source'),outputs:[{path:'/in'}]}]},
 {nodes:[{...node('source'),inputs:[{path:'/in',source:{kind:'object' as const,key:'../source',etag:'x',version:'y',size:8}}]}]}
])('rejects invalid bounded workflow descriptors: %j',override=>{
 expect(()=>validateMediaWorkflowSpec({...spec(),...override})).toThrow();
});
it('bounds canonical UTF-8 workflow payload rather than JavaScript character count',()=>{
 const nodes=Array.from({length:6},(_,i)=>({...node('node'+i),args:Array.from({length:5},()=> '界'.repeat(4000))}));
 expect(()=>validateMediaWorkflowSpec({...spec(),nodes})).toThrow(/bounded payload/);
});
it('pins parent artifact versions without R2 repinning and binds each command to its workflow graph',async()=>{
 const workflow=await signed(),artifact=parentArtifact();
 const job=await deriveMediaJobSpec(workflow,'left',new Map([['source',[artifact]]]));
 expect(job.workflow).toEqual({workflowId:workflow.workflowId,graphHash:workflow.graphHash,nodeId:'left'});expect(job.jobId).toBe('wf-4-fork-left');expect(job.workUnitId).toBe('command');
 expect(job.inputs).toEqual([{path:'/in',key:artifact.key,etag:artifact.etag,version:artifact.version,size:artifact.size}]);
 expect(job.inputFingerprint).toBe(createHash('sha256').update(JSON.stringify(job.inputs)).digest('hex'));
 const other=await deriveMediaJobSpec(workflow,'right',new Map([['source',[artifact]]]));expect(job.graphHash).not.toBe(other.graphHash);
});
it('rejects unavailable, ambiguous and cross-job artifact references',async()=>{
 const workflow=await signed(),artifact=parentArtifact();
 await expect(deriveMediaJobSpec(workflow,'left',new Map())).rejects.toThrow(/Missing/);
 await expect(deriveMediaJobSpec(workflow,'left',new Map([['source',[artifact,artifact]]]))).rejects.toThrow(/ambiguous/);
 await expect(deriveMediaJobSpec(workflow,'left',new Map([['source',[parentArtifact('other')]]]))).rejects.toThrow(/different job/);
 await expect(deriveMediaJobSpec(workflow,'left',new Map([['source',[{...artifact,version:''}]]]))).rejects.toThrow(/input/);
});
it('snapshots parent artifact pins before the first asynchronous hash verification',async()=>{
 const workflow=await signed(),artifact={...parentArtifact()},completed=new Map([['source',[artifact]]]);
 const pending=deriveMediaJobSpec(workflow,'left',completed);
 artifact.version='mutated';completed.clear();
 expect((await pending).inputs[0]!.version).toBe('parent-version');
});

it('preserves and verifies optional source graph provenance in workflow identity',async()=>{
 const original=spec(),bound={...original,sourceGraphHash:'a'.repeat(64)};
 expect(validateMediaWorkflowSpec(bound).sourceGraphHash).toBe(bound.sourceGraphHash);
 expect(await hashMediaWorkflowSpec(bound)).not.toBe(await hashMediaWorkflowSpec(original));
 expect(await hashMediaWorkflowSpec({...bound,sourceGraphHash:'b'.repeat(64)})).not.toBe(await hashMediaWorkflowSpec(bound));
 expect(()=>validateMediaWorkflowSpec({...bound,sourceGraphHash:'forged'})).toThrow(/source graph/);
});
