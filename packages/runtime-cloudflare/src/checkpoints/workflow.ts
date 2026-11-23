import {WorkflowEntrypoint} from 'cloudflare:workers';
import type {WorkflowEvent,WorkflowStep} from 'cloudflare:workers';
import type {DurableObjectId,R2Bucket} from '@cloudflare/workers-types';
import type {MediaCheckpointJournal} from './runner.js';
import type {MediaCheckpointWorkflowSpec} from './workflow-spec.js';
import type {MediaCheckpointWorkflowManifest} from './workflow-result.js';
import type {MediaCheckpointComponentRegistry,MediaCheckpointWorkflowStep} from './workflow-run.js';
import {runMediaCheckpointWorkflow} from './workflow-run.js';
import {mediaCheckpointCoordinatorName} from './state.js';

export interface MediaCheckpointWorkflowEnvironment {
 readonly CHECKPOINTS:{idFromName(name:string):DurableObjectId;get(id:DurableObjectId):MediaCheckpointJournal};
 readonly MEDIA_BUCKET:R2Bucket;
}
/** Durable scheduling of one checkpointed component WorkUnit. Subclass it in the Worker and
 * return the component registry: params carry only the JSON spec, never media code.
 * Create instances with `{id: spec.workflowId, params: spec}`.
 */
export abstract class MediaCheckpointWorkflow<Env extends MediaCheckpointWorkflowEnvironment=MediaCheckpointWorkflowEnvironment> extends WorkflowEntrypoint<Env,MediaCheckpointWorkflowSpec>{
 protected abstract components():MediaCheckpointComponentRegistry;
 async run(event:Readonly<WorkflowEvent<MediaCheckpointWorkflowSpec>>,step:WorkflowStep):Promise<MediaCheckpointWorkflowManifest>{
  // Every step result is one of the plain records declared in workflow-run.ts (structured-clone safe);
  // the engine's step context (`ctx.attempt`) gates the lease handoff between attempts.
  const env=this.env,durable=step as unknown as MediaCheckpointWorkflowStep;
  return runMediaCheckpointWorkflow(event,durable,{bucket:env.MEDIA_BUCKET,components:this.components(),journal:async identity=>env.CHECKPOINTS.get(env.CHECKPOINTS.idFromName(await mediaCheckpointCoordinatorName(identity)))});
 }
}
