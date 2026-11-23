import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {buildMediaCheckpointWorkflowSpec,collectMediaCheckpointOrphans,finalizeMediaCheckpointOutput,loadMediaCheckpoint,mediaCheckpointCoordinatorName,prepareMediaCheckpoint,publishMediaCheckpointWorkflowResult} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import type {MediaCheckpointComponent,MediaCheckpointComponentRegistry,MediaCheckpointDescriptor,MediaCheckpointLease,MediaCheckpointStatus,MediaCheckpointWorkflowBinding,MediaCheckpointWorkflowConfig,MediaCheckpointWorkflowContext,MediaCheckpointWorkflowInput,MediaCheckpointWorkflowSpec} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import {MediaCheckpointWorkflow} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/workflow';
import {MediaCheckpointCoordinator} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object';
import {AudioCheckpointPipelineError,audioCheckpointPipelinePatches,createAudioCheckpointPipeline,deserializeAudioCheckpointPipeline,inspectAudioCheckpointPipeline,validateAudioCheckpointPipelineConfig} from '@edge-ffmpeg/avformat';
import type {AudioCheckpointPipelineConfig,AudioCheckpointPipelinePlan} from '@edge-ffmpeg/avformat';
import {WavError} from '@edge-ffmpeg/containers';
import {AudioConversionError} from '@edge-ffmpeg/swresample';
import type {ReadHandle} from '@edge-ffmpeg/core';
interface PipelineEnv {
 readonly MEDIA_BUCKET:R2Bucket;readonly CHECKPOINTS:DurableObjectNamespace<PipelineCheckpointCoordinator>;
 readonly CHECKPOINT_WORKFLOW:Workflow<MediaCheckpointWorkflowSpec>;
}
const implementationVersion='audio-checkpoint-pipeline-v1',maxObjectBytes=65536,maxRevisions=256;
/** The unchanged coordinator, except that a commit planned in `faults/<jobId>/drop-ack` is applied and its acknowledgement
 * is then lost once. A later identical commit records whether the journal already held it (an exact replay). */
export class PipelineCheckpointCoordinator extends MediaCheckpointCoordinator {
 override async commit(lease:MediaCheckpointLease,descriptor:MediaCheckpointDescriptor):Promise<MediaCheckpointStatus>{
  const bucket=(this.env as unknown as {readonly MEDIA_BUCKET:R2Bucket}).MEDIA_BUCKET,root='faults/'+descriptor.identity.jobId+'/',before=await this.status();
  const held=before?.commits[descriptor.revision-1],replay=held!==undefined&&held.state.key===descriptor.state.key&&held.state.sha256===descriptor.state.sha256;
  const status=await super.commit(lease,descriptor),plan=await bucket.get(root+'drop-ack'),revision=plan?await plan.text():null;
  if(revision===String(descriptor.revision)){
   if(replay){await bucket.put(root+'replayed-'+revision,'1');return status;}
   if(await bucket.put(root+'dropped',revision,{onlyIf:{etagDoesNotMatch:'*'}}))throw Error('Injected lost commit acknowledgement');
  }
  return status;
 }
}
interface FixtureConfig {readonly pipeline:AudioCheckpointPipelineConfig;readonly delayMs:number}
function fixtureConfig(value:unknown):FixtureConfig{
 const config=value as Partial<FixtureConfig>|null;
 if(!config||typeof config!=='object'||Object.keys(config).length!==2||!Number.isSafeInteger(config.delayMs)||config.delayMs!<0||config.delayMs!>2000)throw TypeError('Invalid audio pipeline fixture configuration');
 return {pipeline:validateAudioCheckpointPipelineConfig(config.pipeline!),delayMs:config.delayMs!};
}
/** Ranged reads through the spec's pinned generation only; a whole-object read would exceed `maxReadBytes`. */
function pinned(bucket:R2Bucket,pin:MediaCheckpointWorkflowInput,maxReadBytes:number):ReadHandle{
 const size=BigInt(pin.size);
 return {size,async readAt(offset,length,signal){
  signal?.throwIfAborted();if(offset<0n||!Number.isSafeInteger(length)||length<0||length>maxReadBytes||offset+BigInt(length)>size)throw RangeError('Invalid pinned input range');if(!length)return new Uint8Array();
  const object=await bucket.get(pin.key,{range:{offset:Number(offset),length},onlyIf:{etagMatches:pin.etag}});if(!object||!('body' in object)||!object.body)throw Error('Pinned input object changed');
  if(object.version!==pin.version){await object.body.cancel();throw Error('Pinned input generation changed');}
  const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length!==length)throw Error('Short pinned input range');signal?.throwIfAborted();return bytes;
 }};
}
/** The pipeline's static checks (input codec, tags and layout, every limit) plus its plan against the journal: at most 256 revisions,
 * and unit output and state bounds within the policy's maxObjectBytes. All of it is deterministic for a pinned input, so it fails as
 * a RangeError: the validation step ends the instance at once and a unit step ends it as `failed`, instead of retrying. */
async function planned(spec:MediaCheckpointWorkflowSpec,pipeline:AudioCheckpointPipelineConfig,input:ReadHandle):Promise<AudioCheckpointPipelinePlan>{
 let plan:AudioCheckpointPipelinePlan;
 try{plan=await inspectAudioCheckpointPipeline(pipeline,input);}catch(error){if(error instanceof AudioCheckpointPipelineError||error instanceof WavError||error instanceof AudioConversionError)throw RangeError(error.message,{cause:error});throw error;}
 if(plan.units>maxRevisions)throw RangeError(`Audio pipeline needs ${plan.units} units; the journal holds ${maxRevisions} revisions`);
 if(plan.unitBytes>spec.policy.maxObjectBytes||plan.stateBytes>spec.policy.maxObjectBytes)throw RangeError('Audio pipeline unit output or state bound exceeds the policy maxObjectBytes');
 return plan;
}
const outputFiles=(bucket:R2Bucket)=>createR2FileSystem({bucket,mounts:{'/output':'final'},maxReadBytes:1024,output:{writableMounts:['/output'],stagingPrefix:'final-stage',partBytes:5242880,maxWriteBytes:1024,maxOutputBytes:1048576}});
async function bindPipeline({spec,bucket}:MediaCheckpointWorkflowContext):Promise<MediaCheckpointWorkflowBinding>{
 const {pipeline,delayMs}=fixtureConfig(spec.config),pin=spec.inputs[0];if(spec.inputs.length!==1||!pin)throw TypeError('Audio pipeline needs exactly one pinned WAV input');
 const input=pinned(bucket,pin,pipeline.limits.maxReadBytes);await planned(spec,pipeline,input);const component=createAudioCheckpointPipeline(pipeline,input);
 // Optional per-unit delay so the test can destroy the runtime between commits.
 const delayed:typeof component={...component,async process(state,position,signal){if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));return component.process(state,position,signal);}};
 return {component:delayed as unknown as MediaCheckpointComponent<unknown>,filesystem:outputFiles(bucket),patches:({state,bytes})=>audioCheckpointPipelinePatches(state,bytes,pipeline)};
}
const registry:MediaCheckpointComponentRegistry=new Map([['audio-pipeline',{implementationVersion,bind:bindPipeline}]]);
export class AudioPipelineCheckpointWorkflow extends MediaCheckpointWorkflow {
 protected components():MediaCheckpointComponentRegistry{return registry;}
}
async function body(request:Request):Promise<unknown>{const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let length=0;if(reader)try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>262144){await reader.cancel();throw RangeError('Fixture request limit');}chunks.push(next.value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
type SpecRequest={id:string;jobId:string;input:string;path:string;pipeline:AudioCheckpointPipelineConfig;unitsPerInvocation:number;leaseMs:number;delayMs?:number;dropAck?:number};
export default {async fetch(request:Request,env:PipelineEnv):Promise<Response>{
 const url=new URL(request.url),id=url.searchParams.get('id')??'';
 const journalFor=async(spec:MediaCheckpointWorkflowSpec)=>{const stub=env.CHECKPOINTS.getByName(await mediaCheckpointCoordinatorName(spec.identity));await stub.initialize(spec.identity);return stub;};
 try{
  if(url.pathname==='/status')return Response.json(await(await env.CHECKPOINT_WORKFLOW.get(id)).status());
  if(url.pathname==='/pause'){await(await env.CHECKPOINT_WORKFLOW.get(id)).pause();return Response.json({ok:true});}
  if(url.pathname==='/resume'){await(await env.CHECKPOINT_WORKFLOW.get(id)).resume();return Response.json({ok:true});}
  if(url.pathname==='/spec'){
   const options=await body(request) as SpecRequest;
   const spec=await buildMediaCheckpointWorkflowSpec({bucket:env.MEDIA_BUCKET,workflowId:options.id,jobId:options.jobId,workUnitId:'audio',component:'audio-pipeline',config:{pipeline:options.pipeline as unknown as MediaCheckpointWorkflowConfig,delayMs:options.delayMs??0},implementationVersion,inputs:[{key:options.input}],output:{path:options.path,maxWriteBytes:1024,maxReadBytes:1024},policy:{leaseMs:options.leaseMs,unitsPerInvocation:options.unitsPerInvocation,maxObjectBytes,maxRetries:2,retryDelayMs:50,pollIntervalMs:50,maxInvocations:128,stepTimeoutMs:60000}});
   if(options.dropAck!==undefined)await env.MEDIA_BUCKET.put('faults/'+options.jobId+'/drop-ack',String(options.dropAck));
   const pipeline=fixtureConfig(spec.config).pipeline,plan=await planned(spec,pipeline,pinned(env.MEDIA_BUCKET,spec.inputs[0]!,pipeline.limits.maxReadBytes)).then(value=>({units:value.units,unitBytes:value.unitBytes,stateBytes:value.stateBytes,outputBytes:String(value.outputBytes)}),(error:unknown)=>({error:error instanceof Error?error.message:String(error)}));
   return Response.json({spec,plan});
  }
  const payload=await body(request) as {spec:MediaCheckpointWorkflowSpec;lease?:MediaCheckpointLease;descriptor?:MediaCheckpointDescriptor},spec=payload.spec;
  if(url.pathname==='/start'){const instance=await env.CHECKPOINT_WORKFLOW.create({id:spec.workflowId,params:spec});return Response.json({id:instance.id});}
  if(url.pathname==='/journal')return Response.json(await(await journalFor(spec)).status());
  if(url.pathname==='/stale-prepare'){
   // Another owner claims first, computes revision 1 with the same component and stages it, and never commits it in time.
   const journal=await journalFor(spec),claim=await journal.claim(Number(url.searchParams.get('leaseMs')??1000));if(!claim||claim.status.revision!==0)throw Error('Stale owner could not claim a fresh journal');
   const {component}=await bindPipeline({spec,bucket:env.MEDIA_BUCKET}),state=await component.create(),position={revision:0,inputPosition:'0',outputPosition:'0'};
   try{const unit=await component.process(state,position,undefined),output=unit.output&&unit.output.length?unit.output:null;
    const descriptor=await prepareMediaCheckpoint(env.MEDIA_BUCKET,spec.identity,claim.lease,{revision:1,inputPosition:unit.inputPosition,outputPosition:String(output?.length??0),state:component.serialize(state),output,finished:unit.finished},maxObjectBytes);
    return Response.json({lease:claim.lease,descriptor});}
   finally{component.dispose?.(state);}
  }
  if(url.pathname==='/stale-commit'){try{return Response.json({ok:true,status:await(await journalFor(spec)).commit(payload.lease!,payload.descriptor!)});}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error)});}}
  if(url.pathname==='/collect')return Response.json(await collectMediaCheckpointOrphans({bucket:env.MEDIA_BUCKET,journal:{status:async()=>await(await journalFor(spec)).status() as MediaCheckpointStatus|null},identity:spec.identity}));
  const status=await(await journalFor(spec)).status() as MediaCheckpointStatus|null;if(!status)throw Error('Missing journal');const pipeline=fixtureConfig(spec.config).pipeline;
  if(url.pathname==='/load'){
   // Every committed state decodes strictly and chains to its journal positions; returns the unpatched committed stream.
   const chunks:Uint8Array[]=[];
   for(const descriptor of status.commits){const loaded=await loadMediaCheckpoint(env.MEDIA_BUCKET,descriptor,maxObjectBytes),snapshot=deserializeAudioCheckpointPipeline(loaded.state,pipeline);if(snapshot.resample.received!==descriptor.inputPosition||snapshot.mux.bytes!==descriptor.outputPosition||snapshot.mux.finished!==descriptor.finished)throw Error('Committed pipeline state disagrees with its journal positions');if(loaded.output)chunks.push(loaded.output);}
   return new Response(concat(chunks));
  }
  if(url.pathname==='/finalize'){const result=await finalizeMediaCheckpointOutput({bucket:env.MEDIA_BUCKET,status,filesystem:outputFiles(env.MEDIA_BUCKET),path:url.searchParams.get('path')??'',maxObjectBytes,maxWriteBytes:1024,maxReadBytes:1024,patches:({state,bytes})=>audioCheckpointPipelinePatches(state,bytes,pipeline)});return Response.json({bytes:String(result.bytes),revisions:result.revisions,outputChunks:result.outputChunks,existing:result.existing===true});}
  if(url.pathname==='/publish')return Response.json(await publishMediaCheckpointWorkflowResult(env.MEDIA_BUCKET,spec,status,await bindPipeline({spec,bucket:env.MEDIA_BUCKET})));
  return new Response('Unknown',{status:404});
 }catch(error){const message=(value:unknown):string=>value instanceof AggregateError?value.message+': '+value.errors.map(message).join('; '):value instanceof Error?value.message:String(value);return Response.json({error:message(error)},{status:500});}
}} satisfies ExportedHandler<PipelineEnv>;
