import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {buildMediaCheckpointWorkflowSpec,cancelMediaCheckpointWorkflow,loadMediaCheckpoint,mediaCheckpointCoordinatorName,publishMediaCheckpointWorkflowResult} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import type {MediaCheckpointComponent,MediaCheckpointComponentRegistry,MediaCheckpointStatus,MediaCheckpointWorkflowContext,MediaCheckpointWorkflowSpec} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import {MediaCheckpointWorkflow} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/workflow';
import type {MediaCheckpointCoordinator} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object';
import {createAudioReframeState,serializeAudioReframeCheckpoint,deserializeAudioReframeCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioReframeState} from '@edge-ffmpeg/avfilter';
export {MediaCheckpointCoordinator} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object';
interface CheckpointWorkflowEnv {
 readonly MEDIA_BUCKET:R2Bucket;readonly CHECKPOINTS:DurableObjectNamespace<MediaCheckpointCoordinator>;
 readonly CHECKPOINT_WORKFLOW:Workflow<MediaCheckpointWorkflowSpec>;
}
const limits={maxFrameBytes:1024},maxInputSamples=4096,maxMetadataBytes=4096,inputKey='inputs/fifo.s16le',implementationVersion='reframe-workflow-v1';
type Frame={samples:number;pts:string};
interface FifoUnitState {readonly fifo:AudioReframeState;frames:Frame[]}
/** Component configuration carried by the spec; the code below is registered in this Worker only. */
interface FifoConfig {readonly n:number;readonly pad:0|1;readonly unitSamples:number;readonly delayMs:number;readonly faultAt:string|null}
function packed(frame:AudioFrameData){const bytes=new Uint8Array(frame.samples*4);for(let sample=0;sample<frame.samples;sample++)for(let channel=0;channel<2;channel++)bytes.set(frame.planes[channel]!.subarray(sample*2,sample*2+2),(sample*2+channel)*2);return bytes;}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
// State blob: u32le metadata length, bounded JSON of the last unit's emitted frames, FIFO checkpoint.
function encode(state:FifoUnitState):Uint8Array{const meta=new TextEncoder().encode(JSON.stringify(state.frames)),fifo=serializeAudioReframeCheckpoint(state.fifo.checkpoint(),limits);if(meta.length>maxMetadataBytes)throw Error('Fixture metadata bound');const bytes=new Uint8Array(4+meta.length+fifo.length);new DataView(bytes.buffer).setUint32(0,meta.length,true);bytes.set(meta,4);bytes.set(fifo,4+meta.length);return bytes;}
function decode(bytes:Uint8Array):{frames:Frame[];fifo:Uint8Array}{
 if(bytes.length<4)throw Error('Truncated fixture state');const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);if(length>maxMetadataBytes||4+length>bytes.length)throw Error('Invalid fixture state metadata');
 const frames=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.subarray(4,4+length))) as unknown;if(!Array.isArray(frames)||frames.some(frame=>!frame||!Number.isSafeInteger(frame.samples)||typeof frame.pts!=='string'))throw Error('Invalid fixture frame metadata');return {frames:frames as Frame[],fifo:bytes.subarray(4+length)};
}
function fifoConfig(value:unknown):FifoConfig{
 const config=value as Partial<FifoConfig>|null;
 if(!config||config.n!==3||config.pad!==0&&config.pad!==1||!Number.isSafeInteger(config.unitSamples)||config.unitSamples!<1||config.unitSamples!>64||!Number.isSafeInteger(config.delayMs)||config.delayMs!<0||config.delayMs!>2000||config.faultAt!==null&&typeof config.faultAt!=='string')throw TypeError('Invalid FIFO component configuration');
 return config as FifoConfig;
}
/** The asetnsamples FIFO, reading 5-sample units through the spec's pinned input generation. */
function bindFifo({spec,bucket}:MediaCheckpointWorkflowContext){
 const config=fifoConfig(spec.config),pin=spec.inputs[0]!;if(spec.inputs.length!==1||pin.key!==inputKey||pin.size%4||pin.size/4>maxInputSamples)throw TypeError('FIFO component needs one bounded stereo s16le input');const total=pin.size/4;
 async function read(start:number,count:number):Promise<AudioFrameData>{
  const object=await bucket.get(pin.key,{range:{offset:start*4,length:count*4},onlyIf:{etagMatches:pin.etag}});if(!object||!('body' in object)||!object.body)throw Error('Pinned input object changed');
  if(object.version!==pin.version){await object.body.cancel();throw Error('Pinned input generation changed');}
  const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length!==count*4)throw Error('Short pinned input range');
  const planes=[new Uint8Array(count*2),new Uint8Array(count*2)];for(let sample=0;sample<count;sample++)for(let channel=0;channel<2;channel++)planes[channel]!.set(bytes.subarray((sample*2+channel)*2,(sample*2+channel)*2+2),sample*2);
  return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:count,planes,pts:{value:123n+BigInt(start),timeBase:{num:1n,den:8000n}}};
 }
 const component:MediaCheckpointComponent<FifoUnitState>={
  create:()=>({fifo:createAudioReframeState(config.n,config.pad===1,limits),frames:[]}),
  restore:bytes=>{const saved=decode(bytes);return {fifo:createAudioReframeState(config.n,config.pad===1,limits,deserializeAudioReframeCheckpoint(saved.fifo,limits)),frames:[]};},
  async process(state,position,signal){
   signal?.throwIfAborted();const start=Number(position.inputPosition),count=Math.min(config.unitSamples,total-start);if(!Number.isSafeInteger(start)||count<1)throw Error('Unit outside pinned input');
   if(config.delayMs)await new Promise(resolve=>setTimeout(resolve,config.delayMs));
   // One injected provider failure per position, recorded durably so only the first attempt fails.
   if(config.faultAt===position.inputPosition&&await bucket.put(`faults/${spec.identity.jobId}/${position.inputPosition}`,'1',{onlyIf:{etagDoesNotMatch:'*'}}))throw Error('Injected transient R2 failure');
   const chunks:Uint8Array[]=[];state.frames=[];const collect=(frame:AudioFrameData)=>{chunks.push(packed(frame));state.frames.push({samples:frame.samples,pts:String(frame.pts!.value)});};
   for(const frame of state.fifo.push(await read(start,count)))collect(frame);const finished=start+count===total;if(finished){const tail=state.fifo.finish();if(tail)collect(tail);}
   return {output:chunks.length?concat(chunks):null,inputPosition:String(start+count),finished};
  },
  serialize:encode,
  verify:(state,position)=>{const checkpoint=state.fifo.checkpoint();return checkpoint.received===position.inputPosition&&(BigInt(checkpoint.emitted)*4n).toString()===position.outputPosition;},
  dispose:state=>state.fifo.dispose(),
 };
 const filesystem=createR2FileSystem({bucket,mounts:{'/output':'final'},maxReadBytes:1024,output:{writableMounts:['/output'],stagingPrefix:'final-stage',partBytes:5242880,maxWriteBytes:1024,maxOutputBytes:1048576}});
 return {component:component as MediaCheckpointComponent<unknown>,filesystem};
}
const registry:MediaCheckpointComponentRegistry=new Map([['asetnsamples',{implementationVersion,bind:bindFifo}]]);
export class FifoCheckpointWorkflow extends MediaCheckpointWorkflow {
 protected components():MediaCheckpointComponentRegistry{return registry;}
}
async function body(request:Request):Promise<unknown>{const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let length=0;if(reader)try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>131072){await reader.cancel();throw RangeError('Fixture request limit');}chunks.push(next.value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));}
type CreateRequest={jobId:string;pad:0|1;path:string;unitsPerInvocation:number;leaseMs:number;delayMs?:number;faultAt?:string;implementationVersion?:string;foreignLeaseMs?:number};
export default {async fetch(request:Request,env:CheckpointWorkflowEnv):Promise<Response>{
 const url=new URL(request.url),id=url.searchParams.get('id')??'';
 const journalFor=async(spec:MediaCheckpointWorkflowSpec)=>{const stub=env.CHECKPOINTS.getByName(await mediaCheckpointCoordinatorName(spec.identity));await stub.initialize(spec.identity);return stub;};
 try{
  if(url.pathname==='/create'){
   const options=await body(request) as CreateRequest;
   const spec=await buildMediaCheckpointWorkflowSpec({bucket:env.MEDIA_BUCKET,workflowId:id,jobId:options.jobId,workUnitId:'audio',component:'asetnsamples',config:{n:3,pad:options.pad,unitSamples:5,delayMs:options.delayMs??0,faultAt:options.faultAt??null},implementationVersion:options.implementationVersion??implementationVersion,inputs:[{key:inputKey}],output:{path:options.path,maxWriteBytes:1024,maxReadBytes:1024},policy:{leaseMs:options.leaseMs,unitsPerInvocation:options.unitsPerInvocation,maxObjectBytes:2048,maxRetries:2,retryDelayMs:50,pollIntervalMs:50,maxInvocations:64,stepTimeoutMs:60000}});
   // Optionally hold the journal with another owner's live lease before the instance starts.
   const foreign=options.foreignLeaseMs?await(await journalFor(spec)).claim(options.foreignLeaseMs):null;
   const instance=await env.CHECKPOINT_WORKFLOW.create({id,params:spec});return Response.json({id:instance.id,spec,foreign});
  }
  if(url.pathname==='/status')return Response.json(await(await env.CHECKPOINT_WORKFLOW.get(id)).status());
  if(url.pathname==='/pause'){await(await env.CHECKPOINT_WORKFLOW.get(id)).pause();return Response.json({ok:true});}
  if(url.pathname==='/resume'){await(await env.CHECKPOINT_WORKFLOW.get(id)).resume();return Response.json({ok:true});}
  const spec=await body(request) as MediaCheckpointWorkflowSpec;
  if(url.pathname==='/journal')return Response.json(await(await journalFor(spec)).status());
  if(url.pathname==='/foreign-claim')return Response.json(await(await journalFor(spec)).claim(Number(url.searchParams.get('leaseMs')??1000)));
  // Direct publication verifies the destination through the component's own output binding first.
  if(url.pathname==='/publish'){const status=await(await journalFor(spec)).status() as MediaCheckpointStatus|null;if(!status)throw Error('Missing journal');return Response.json(await publishMediaCheckpointWorkflowResult(env.MEDIA_BUCKET,spec,status,bindFifo({spec,bucket:env.MEDIA_BUCKET})));}
  if(url.pathname==='/cancel'){try{return Response.json({ok:true,result:await cancelMediaCheckpointWorkflow(spec,{workflow:env.CHECKPOINT_WORKFLOW,CHECKPOINTS:{idFromName:name=>env.CHECKPOINTS.idFromName(name),get:target=>{const stub=env.CHECKPOINTS.get(target);return {initialize:async identity=>await stub.initialize(identity) as MediaCheckpointStatus,cancel:async()=>await stub.cancel() as MediaCheckpointStatus};}}})});}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error),details:typeof error==='object'&&error!==null&&'details' in error?error.details:null});}}
  if(url.pathname==='/frames'){
   const status=await(await journalFor(spec)).status() as MediaCheckpointStatus|null;if(!status)throw Error('Missing journal');const frames:Frame[]=[];
   for(const descriptor of status.commits){const loaded=await loadMediaCheckpoint(env.MEDIA_BUCKET,descriptor,2048);frames.push(...decode(loaded.state).frames);}return Response.json(frames);
  }
  return new Response('Unknown',{status:404});
 }catch(error){const message=(value:unknown):string=>value instanceof AggregateError?value.message+': '+value.errors.map(message).join('; '):value instanceof Error?value.message:String(value);return Response.json({error:message(error)},{status:500});}
}} satisfies ExportedHandler<CheckpointWorkflowEnv>;
