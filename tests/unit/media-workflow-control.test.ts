import {expect,it,vi} from 'vitest';
import type {DurableObjectId} from '@cloudflare/workers-types';
import type {MediaJobWorkflowIdentity} from '../../packages/runtime-cloudflare/src/jobs/types.js';
import type {MediaWorkflowNode,MediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-types.js';
import {hashMediaWorkflowSpec} from '../../packages/runtime-cloudflare/src/jobs/workflow-plan.js';
import {cancelMediaWorkflow,MediaWorkflowCancellationError} from '../../packages/runtime-cloudflare/src/jobs/workflow-control.js';
let sequence=0;
async function setup(){
 const node=(id:string):MediaWorkflowNode=>({id,args:['-i','/in','/out'],inputs:[{path:'/in',source:{kind:'object',key:'source',etag:'e',version:'v',size:1}}],outputs:[{path:'/out'}],budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},implementationVersion:'test-v1',maxAttempts:2,leaseMs:1000});
 const parent=node('parent'),peer=node('peer'),child={...node('child'),inputs:[{path:'/in',source:{kind:'artifact' as const,nodeId:'parent',path:'/out'}}]};
 const draft:MediaWorkflowSpec={version:1,workflowId:`cancel-${sequence++}`,graphHash:'0'.repeat(64),nodes:[parent,peer,child],maxParallel:2,pollIntervalMs:50,maxPolls:10};const spec={...draft,graphHash:await hashMediaWorkflowSpec(draft)};
 const fences=new Map<string,MediaJobWorkflowIdentity>(),events:string[]=[];
 const cancel=vi.fn(async(owner:MediaJobWorkflowIdentity)=>{events.push(`fenced:${owner.nodeId}`);fences.set(owner.nodeId,{...owner});return null;});
 const terminate=vi.fn(async()=>{events.push('terminate');}),status=vi.fn(async()=>({status:'terminated'})),getWorkflow=vi.fn(async()=>({terminate,status}));
 const idFromName=(name:string):DurableObjectId=>({name,toString:()=>name,equals:other=>other.toString()===name});
 const get=vi.fn(()=>({cancelWorkflowNode:cancel}));
 return {spec,fences,events,cancel,terminate,status,getWorkflow,get,options:{workflow:{get:getWorkflow},JOBS:{idFromName,get}}};
}
it('fences all nodes including an unsubmitted dependent before platform termination',async()=>{
 const run=await setup();const result=await cancelMediaWorkflow(run.spec,run.options);expect(result.nodeCount).toBe(3);expect(result.fencedNodeIds).toEqual(['parent','peer','child']);expect(result.workflowStatus).toBe('terminated');expect(run.events).toEqual(['fenced:parent','fenced:peer','fenced:child','terminate']);
 expect(run.fences.get('child')).toEqual({workflowId:run.spec.workflowId,graphHash:run.spec.graphHash,nodeId:'child'});
});
it('awaits every fence and never races a pending sibling with termination',async()=>{
 const run=await setup();let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});const original=run.cancel.getMockImplementation()!;
 run.cancel.mockImplementation(async owner=>{if(owner.nodeId==='child')await pending;return original(owner);});
 const task=cancelMediaWorkflow(run.spec,run.options);await vi.waitFor(()=>expect(run.cancel).toHaveBeenCalledTimes(3));expect(run.terminate).not.toHaveBeenCalled();release();expect((await task).workflowStatus).toBe('terminated');
});
it('preserves confirmed fences but does not terminate after any foreign ownership conflict',async()=>{
 const run=await setup(),original=run.cancel.getMockImplementation()!;run.cancel.mockImplementation(async owner=>{if(owner.nodeId==='peer')throw Error('Foreign workflow ownership conflict');return original(owner);});
 let failure:unknown;try{await cancelMediaWorkflow(run.spec,run.options);}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(MediaWorkflowCancellationError);const details=(failure as MediaWorkflowCancellationError).details;expect(details.fencedNodeIds).toEqual(['parent','child']);expect(details.failures).toEqual([{nodeId:'peer',message:'Foreign workflow ownership conflict'}]);expect(details.terminationConfirmed).toBe(false);expect(run.getWorkflow).not.toHaveBeenCalled();expect(run.terminate).not.toHaveBeenCalled();
});
it.each(['complete','errored','terminated'])('reconciles a lost or unnecessary termination response with terminal status: %s',async state=>{
 const run=await setup();run.terminate.mockRejectedValue(Error('Already terminal or lost reply'));run.status.mockResolvedValue({status:state});expect((await cancelMediaWorkflow(run.spec,run.options)).workflowStatus).toBe(state);expect(run.status).toHaveBeenCalledOnce();
});
it('reports a nonterminal platform result as incomplete while retaining every node fence',async()=>{
 const run=await setup();run.terminate.mockRejectedValue(Error('Terminate unavailable'));run.status.mockResolvedValue({status:'running'});
 await expect(cancelMediaWorkflow(run.spec,run.options)).rejects.toMatchObject({details:{terminationConfirmed:false,workflowStatus:'running',fencedNodeIds:['parent','peer','child'],failures:[{nodeId:'$workflow',message:'Terminate unavailable'}]}});expect(run.fences.size).toBe(3);
});
it('can retry after uncertain platform termination without removing any persisted fence',async()=>{
 const run=await setup();run.terminate.mockRejectedValueOnce(Error('Lost termination response'));run.status.mockRejectedValueOnce(Error('Status unavailable'));
 await expect(cancelMediaWorkflow(run.spec,run.options)).rejects.toBeInstanceOf(MediaWorkflowCancellationError);expect(run.fences.size).toBe(3);
 expect((await cancelMediaWorkflow(run.spec,run.options)).workflowStatus).toBe('terminated');expect(run.fences.size).toBe(3);expect(run.cancel).toHaveBeenCalledTimes(6);
});
it('supports an idempotent repeated cancellation against an already terminated instance',async()=>{
 const run=await setup();await cancelMediaWorkflow(run.spec,run.options);run.terminate.mockRejectedValueOnce(Error('Already terminated'));expect((await cancelMediaWorkflow(run.spec,run.options)).fencedNodeIds).toEqual(['parent','peer','child']);expect(run.fences.size).toBe(3);
});
it('verifies the entire supplied graph before any fence or termination I/O',async()=>{
 const run=await setup();await expect(cancelMediaWorkflow({...run.spec,graphHash:'f'.repeat(64)},run.options)).rejects.toThrow(/hash/i);expect(run.get).not.toHaveBeenCalled();expect(run.getWorkflow).not.toHaveBeenCalled();
});
it('snapshots the submitted graph before awaiting verification',async()=>{
 const run=await setup(),nodes=[...run.spec.nodes],task=cancelMediaWorkflow({...run.spec,nodes},run.options);nodes.length=0;expect((await task).nodeCount).toBe(3);expect(run.fences.size).toBe(3);
});
it('bounds retained provider diagnostics in a partial cancellation result',async()=>{
 const run=await setup();run.cancel.mockRejectedValue(Error('x'.repeat(10000)));await expect(cancelMediaWorkflow(run.spec,run.options)).rejects.toMatchObject({details:{terminationConfirmed:false}});
 try{await cancelMediaWorkflow(run.spec,run.options);}catch(error){expect(error).toBeInstanceOf(MediaWorkflowCancellationError);expect((error as MediaWorkflowCancellationError).details.failures.every(item=>item.message.length===2048)).toBe(true);}
 expect(run.terminate).not.toHaveBeenCalled();
});
