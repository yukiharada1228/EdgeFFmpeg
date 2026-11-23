import {expect,it} from 'vitest';
import type {R2Bucket} from '@cloudflare/workers-types';
import {buildMediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-spec.js';
import {verifyMediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-plan.js';
const budget={maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:15000,maxPendingPackets:8};
function fixture(){let heads=0;const bucket={async head(key:string){heads++;return {key,version:`generation-${heads}`,etag:'same-content',httpEtag:'"same-content"',size:8,uploaded:new Date(0),storageClass:'Standard',checksums:{toJSON(){return {};}},writeHttpMetadata(){}};}} satisfies Pick<R2Bucket,'head'>;
 const node={id:'a',args:['-i','/in','/out'],inputs:[{path:'/in',source:{kind:'object' as const,key:'source/audio'}}],outputs:[{path:'/out'}],budget,implementationVersion:'v1'};return {bucket,node,get heads(){return heads;}};}
it('pins shared external inputs once and leaves dependency artifacts to their producers',async()=>{
 const run=fixture();const nodes=[run.node,{...run.node,id:'b'},{...run.node,id:'c',inputs:[{path:'/in',source:{kind:'artifact' as const,nodeId:'a',path:'/out'}}]}];
 const spec=await buildMediaWorkflowSpec({bucket:run.bucket,workflowId:'graph',nodes});
 expect(run.heads).toBe(1);expect(spec.nodes[0]!.inputs[0]!.source).toEqual(spec.nodes[1]!.inputs[0]!.source);expect(spec.nodes[2]!.inputs[0]!.source).toEqual({kind:'artifact',nodeId:'a',path:'/out'});expect(await verifyMediaWorkflowSpec(spec)).toEqual(spec);expect(Object.isFrozen(spec.nodes[0]!.inputs[0]!.source)).toBe(true);
});
it('snapshots the graph before provider callbacks can change arguments or scheduling',async()=>{
 const run=fixture(),options={bucket:run.bucket,workflowId:'snapshot',nodes:[{...run.node,args:[...run.node.args],budget:{...budget}}],maxParallel:2};
 const pending=buildMediaWorkflowSpec(options);options.nodes[0]!.args[0]='mutated';options.nodes[0]!.budget.maxBufferBytes=1;options.maxParallel=16;
 const spec=await pending;expect(spec.nodes[0]!.args[0]).toBe('-i');expect(spec.nodes[0]!.budget.maxBufferBytes).toBe(65536);expect(spec.maxParallel).toBe(2);
});
it('rejects cycles and missing dependencies before contacting R2',async()=>{
 const run=fixture(),cyclic={...run.node,inputs:[{path:'/in',source:{kind:'artifact' as const,nodeId:'a',path:'/out'}}]};
 await expect(buildMediaWorkflowSpec({bucket:run.bucket,workflowId:'bad',nodes:[cyclic]})).rejects.toThrow(/Cyclic/);
 await expect(buildMediaWorkflowSpec({bucket:run.bucket,workflowId:'bad',nodes:[{...cyclic,inputs:[{path:'/in',source:{kind:'artifact',nodeId:'missing',path:'/out'}}]}]})).rejects.toThrow(/Missing/);expect(run.heads).toBe(0);
});
it('refuses missing external generations rather than producing a partially pinned graph',async()=>{
 const run=fixture();await expect(buildMediaWorkflowSpec({bucket:{async head(){return null;}},workflowId:'missing',nodes:[run.node]})).rejects.toThrow(/missing/);
});
