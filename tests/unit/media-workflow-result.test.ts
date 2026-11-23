import {afterAll,beforeAll,expect,it} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {R2Bucket} from '@cloudflare/workers-types';
import type {MediaJobArtifact,MediaJobStatus} from '../../packages/runtime-cloudflare/src/jobs/types.js';
import type {MediaWorkflowNode,MediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-types.js';
import {hashMediaWorkflowSpec,mediaWorkflowJobId} from '../../packages/runtime-cloudflare/src/jobs/workflow-plan.js';
import {publishMediaWorkflowResult} from '../../packages/runtime-cloudflare/src/jobs/workflow-result.js';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-11-18',r2Buckets:['BUCKET']}));
let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>;
beforeAll(async()=>{await mf.ready;bucket=await mf.getR2Bucket('BUCKET');});afterAll(async()=>{await mf.dispose();});
let sequence=0;
async function setup(nodes=1,outputs=1){
 const workflowId=`result-${sequence++}`,node=(index:number):MediaWorkflowNode=>({id:`node-${index}`,args:['-i','/in','/out'],inputs:[{path:'/in',source:{kind:'object',key:'source',etag:'input-etag',version:'input-version',size:1}}],outputs:Array.from({length:outputs},(_,index)=>({path:`/out-${index}`})),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},implementationVersion:'test-v1',maxAttempts:2,leaseMs:1000});
 const spec:MediaWorkflowSpec={version:1,workflowId,graphHash:'0'.repeat(64),nodes:Array.from({length:nodes},(_,index)=>node(index)),maxParallel:1,pollIntervalMs:50,maxPolls:10};
 const verified={...spec,graphHash:await hashMediaWorkflowSpec(spec)};
 const statuses=new Map<string,Pick<MediaJobStatus,'phase'|'artifacts'>>();for(const node of spec.nodes)statuses.set(node.id,{phase:'succeeded',artifacts:node.outputs.map((output,index)=>({path:output.path,key:`jobs/${mediaWorkflowJobId(workflowId,node.id)}/1/token/output-${index}`,etag:'artifact-etag',version:'artifact-version',size:index+1}))});
 // The Miniflare RPC bridge substitutes Node Headers/Streams for Worker types.
 return {spec:verified,statuses,bucket:bucket as R2Bucket & typeof bucket};
}
it('publishes a bounded immutable manifest containing exact artifact generations',async()=>{
 const run=await setup(2),result=await publishMediaWorkflowResult(run.bucket,run.spec,run.statuses);expect(result.key).toBe(`workflows/${run.spec.workflowId}/${run.spec.graphHash}.json`);expect(result.jobCount).toBe(2);expect(result.version).not.toBe('');expect(result.size).toBeLessThanOrEqual(524288);
 const object=await bucket.get(result.key),body=JSON.parse(await object!.text()) as {version:number;artifacts:Record<string,MediaJobArtifact[]>};expect(body.version).toBe(1);expect(body.artifacts['node-0']![0]!.version).toBe('artifact-version');expect(object!.customMetadata?.edgeWorkflowResultSha256).toBe(result.sha256);
 expect(await publishMediaWorkflowResult(run.bucket,run.spec,new Map([...run.statuses].reverse()))).toEqual(result);
});
it('reconciles a lost conditional-put response against exact bytes and metadata',async()=>{
 const run=await setup();let writes=0;
 const uncertain=new Proxy(run.bucket,{get(target,property){if(property==='put')return async(...args:Parameters<R2Bucket['put']>)=>{writes++;await target.put(...args);throw Error('Lost manifest response');};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
 const result=await publishMediaWorkflowResult(uncertain,run.spec,run.statuses);expect(writes).toBe(1);expect((await bucket.head(result.key))!.version).toBe(result.version);
});
it('rejects a conflicting immutable result without overwriting it',async()=>{
 const run=await setup(),key=`workflows/${run.spec.workflowId}/${run.spec.graphHash}.json`;await bucket.put(key,'existing result');
 await expect(publishMediaWorkflowResult(run.bucket,run.spec,run.statuses)).rejects.toThrow(/conflict/);expect(await (await bucket.get(key))!.text()).toBe('existing result');
});
it('verifies body bytes even when copied metadata and size match',async()=>{
 const run=await setup(),result=await publishMediaWorkflowResult(run.bucket,run.spec,run.statuses),object=(await bucket.get(result.key))!;const bytes=new Uint8Array(await object.arrayBuffer());bytes[0]=bytes[0]!^1;
 await bucket.put(result.key,bytes,{customMetadata:object.customMetadata??{}});await expect(publishMediaWorkflowResult(run.bucket,run.spec,run.statuses)).rejects.toThrow(/byte conflict/);
});
it.each(['queued','running','failed','cancelled'] as const)('does not publish incomplete workflow state: %s',async phase=>{
 const run=await setup();run.statuses.set('node-0',{phase,artifacts:[]});await expect(publishMediaWorkflowResult(run.bucket,run.spec,run.statuses)).rejects.toThrow(/successful nodes/);expect(await bucket.head(`workflows/${run.spec.workflowId}/${run.spec.graphHash}.json`)).toBeNull();
});
it('rejects artifact paths from another command and a forged graph identity',async()=>{
 const run=await setup(),original=run.statuses.get('node-0')!;run.statuses.set('node-0',{phase:'succeeded',artifacts:original.artifacts.map(item=>({...item,key:'jobs/other/1/token/output-0'}))});await expect(publishMediaWorkflowResult(run.bucket,run.spec,run.statuses)).rejects.toThrow(/declared outputs/);
 run.statuses.set('node-0',original);await expect(publishMediaWorkflowResult(run.bucket,{...run.spec,graphHash:'f'.repeat(64)},run.statuses)).rejects.toThrow(/hash/i);
});
it('rejects oversized aggregate metadata before writing R2',async()=>{
 const run=await setup(16,16);for(const [id,status]of run.statuses)run.statuses.set(id,{phase:'succeeded',artifacts:status.artifacts.map(item=>({...item,key:item.key+'k'.repeat(3900),etag:'e'.repeat(4096),version:'v'.repeat(4096)}))});
 await expect(publishMediaWorkflowResult(run.bucket,run.spec,run.statuses)).rejects.toThrow(/byte limit/);expect(await bucket.head(`workflows/${run.spec.workflowId}/${run.spec.graphHash}.json`)).toBeNull();
});
it('preserves a __proto__ node and sorts Unicode output paths by code units',async()=>{
 const run=await setup(),id='__proto__',paths=['/é','/z','/ä','/A','/_'];
 const node={...run.spec.nodes[0]!,id,outputs:paths.map(path=>({path}))},draft={...run.spec,nodes:[node]},spec={...draft,graphHash:await hashMediaWorkflowSpec(draft)};
 const artifacts=paths.map((path,index)=>({path,key:`jobs/${mediaWorkflowJobId(spec.workflowId,id)}/1/token/output-${index}`,etag:'e',version:'v',size:1}));
 const statuses=new Map<string,Pick<MediaJobStatus,'phase'|'artifacts'>>([[id,{phase:'succeeded',artifacts}]]),result=await publishMediaWorkflowResult(run.bucket,spec,statuses);
 const body=JSON.parse(await (await bucket.get(result.key))!.text()) as {artifacts:Record<string,MediaJobArtifact[]>};expect(Object.keys(body.artifacts)).toEqual([id]);expect(body.artifacts[id]!.map(item=>item.path)).toEqual(['/A','/_','/z','/ä','/é']);
 statuses.set(id,{phase:'succeeded',artifacts:[...artifacts].reverse()});expect(await publishMediaWorkflowResult(run.bucket,spec,statuses)).toEqual(result);
});
it('snapshots statuses and artifact objects before awaiting graph verification',async()=>{
 const run=await setup(),artifacts=run.statuses.get('node-0')!.artifacts.map(item=>({...item}));run.statuses.set('node-0',{phase:'succeeded',artifacts});
 const pending=publishMediaWorkflowResult(run.bucket,run.spec,run.statuses);artifacts[0]!.version='caller mutation';run.statuses.clear();
 const result=await pending,body=JSON.parse(await (await bucket.get(result.key))!.text()) as {artifacts:Record<string,MediaJobArtifact[]>};expect(body.artifacts['node-0']![0]!.version).toBe('artifact-version');
});
