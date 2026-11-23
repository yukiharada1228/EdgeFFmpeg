import {WorkflowEntrypoint} from 'cloudflare:workers';
import type {WorkflowEvent,WorkflowStep} from 'cloudflare:workers';
import type {DurableObjectId,R2Bucket} from '@cloudflare/workers-types';
import type {MediaJobArtifact,MediaJobCoordinatorClient,MediaJobSpec,MediaJobStatus,MediaJobWorkflowIdentity} from './types.js';
import type {MediaWorkflowSpec} from './workflow-types.js';
import {deriveMediaJobSpec,mediaWorkflowJobId,readyMediaWorkflowNodes,verifyMediaWorkflowSpec} from './workflow-plan.js';
import {publishMediaWorkflowResult} from './workflow-result.js';
import type {MediaWorkflowManifest} from './workflow-result.js';

export interface MediaWorkflowEnvironment {
 readonly JOBS:{idFromName(name:string):DurableObjectId;get(id:DurableObjectId):MediaJobCoordinatorClient&{cancelSubmitted(spec:MediaJobSpec):Promise<MediaJobStatus>;cancelWorkflowNode(owner:MediaJobWorkflowIdentity):Promise<MediaJobStatus|null>}};
 readonly MEDIA_BUCKET:R2Bucket;
}
type CompactStatus=Pick<MediaJobStatus,'phase'|'artifacts'|'error'>;
const compact=(status:MediaJobStatus|null):CompactStatus=>{if(!status)throw Error('Submitted workflow job is missing');return {phase:status.phase,artifacts:status.artifacts,error:status.error};};
const isTerminal=(status:CompactStatus)=>['succeeded','failed','cancelled'].includes(status.phase);
const validationConfig={retries:{limit:0,delay:100},timeout:'30 seconds'} as const;
const operationConfig={retries:{limit:3,delay:100,backoff:'exponential'},timeout:'30 seconds'} as const;

/** Durable orchestration of complete command jobs. Individual media execution
 * is delivered by Queues; Workflow steps never represent codec checkpoints.
 */
export class MediaWorkflow extends WorkflowEntrypoint<MediaWorkflowEnvironment,MediaWorkflowSpec>{
 async run(event:Readonly<WorkflowEvent<MediaWorkflowSpec>>,step:WorkflowStep):Promise<MediaWorkflowManifest>{
  if(event.instanceId!==event.payload.workflowId)throw Error('Workflow instance identity mismatch');
  if(new TextEncoder().encode(JSON.stringify(event.payload)).length>262144)throw RangeError('Workflow request byte limit exceeded');
  const spec=await step.do('validate-workflow',validationConfig,()=>verifyMediaWorkflowSpec(event.payload));
  const submitted=new Set<string>(),expectedJobs=new Map<string,MediaJobSpec>(),statuses=new Map<string,CompactStatus>(),completed=new Map<string,readonly MediaJobArtifact[]>();
  const client=(nodeId:string)=>this.env.JOBS.get(this.env.JOBS.idFromName(mediaWorkflowJobId(spec.workflowId,nodeId)));
  try{
   for(let round=0;round<spec.maxPolls;round++){
    const running=new Set([...submitted].filter(id=>!completed.has(id)));
    const ready=readyMediaWorkflowNodes(spec,new Set(completed.keys()),running);
    const derived=await Promise.allSettled(ready.map(node=>step.do(`derive-${node.id}`,operationConfig,()=>deriveMediaJobSpec(spec,node.id,completed))));
    const derivationError=derived.find(result=>result.status==='rejected');if(derivationError?.status==='rejected')throw derivationError.reason;
    for(let index=0;index<derived.length;index++){const result=derived[index]!;if(result.status==='fulfilled')expectedJobs.set(ready[index]!.id,result.value);}
    for(const node of ready)submitted.add(node.id);
    // Wait for every independent submission even if one exhausts step retries:
    // some peers may already be queued and must be cancelled in the catch path.
    const submissions=await Promise.allSettled(ready.map(node=>step.do(`submit-${node.id}`,operationConfig,async()=>{
     return compact(await client(node.id).submit(expectedJobs.get(node.id)!));
    })));
    for(let index=0;index<submissions.length;index++){const result=submissions[index]!;if(result.status==='fulfilled')statuses.set(ready[index]!.id,result.value);}
    const submissionError=submissions.find(result=>result.status==='rejected');if(submissionError?.status==='rejected')throw submissionError.reason;
    const pending=[...submitted].filter(id=>!statuses.has(id)||!isTerminal(statuses.get(id)!));
    const polls=await Promise.allSettled(pending.map(id=>step.do(`poll-${round}-${id}`,operationConfig,async()=>compact(await client(id).status()))));
    for(let index=0;index<polls.length;index++){const result=polls[index]!;if(result.status==='fulfilled')statuses.set(pending[index]!,result.value);}
    const pollError=polls.find(result=>result.status==='rejected');if(pollError?.status==='rejected')throw pollError.reason;
    for(const [id,status]of statuses){
     if(status.phase==='succeeded')completed.set(id,status.artifacts);
     else if(status.phase==='failed'||status.phase==='cancelled')throw Error(`Workflow job ${id} ${status.phase}: ${status.error??'no diagnostic'}`);
    }
    if(completed.size===spec.nodes.length)return await step.do('publish-workflow-result',operationConfig,()=>publishMediaWorkflowResult(this.env.MEDIA_BUCKET,spec,statuses));
    if(round+1<spec.maxPolls)await step.sleep(`wait-${round}`,spec.pollIntervalMs);
   }
   throw Error('Workflow polling budget exhausted');
  }catch(error){
   // Cancellation is idempotent and uses independent durable steps. External
   // platform termination does not execute this catch or imply a cascade.
   const cancellations=await Promise.allSettled(spec.nodes.map(node=>node.id).filter(id=>!statuses.has(id)||!isTerminal(statuses.get(id)!)).map(id=>step.do(`cancel-${id}`,operationConfig,async()=>{
    // Atomically tombstone this exact immutable spec, even if a timed-out
    // submit has not arrived yet. A different preexisting spec is preserved.
    const expected=expectedJobs.get(id);if(expected)await client(id).cancelSubmitted(expected);else await client(id).cancelWorkflowNode({workflowId:spec.workflowId,graphHash:spec.graphHash,nodeId:id});return null;
   })));
   const cleanup=cancellations.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
   if(cleanup.length)throw new AggregateError([error,...cleanup],'Workflow failed and child cancellation could not be confirmed');
   throw error;
  }
 }
}
