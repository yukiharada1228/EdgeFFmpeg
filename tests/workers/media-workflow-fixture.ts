import {FFmpeg,FeatureRegistry} from '@edge-ffmpeg/core';
import type {CommandOperatorBinding,OperatorDescriptor} from '@edge-ffmpeg/core';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {buildComplexVideoGraphMediaWorkflowSpec,buildCommandGraphMediaWorkflowSpec,cancelMediaWorkflow,buildMediaWorkflowSpec,deriveMediaJobSpec,publishMediaWorkflowResult,mediaWorkflowJobId,consumeMediaJobs} from '@edge-ffmpeg/runtime-cloudflare/jobs';
import type {MediaWorkflowSpec,MediaJobStatus,MediaJobMessage} from '@edge-ffmpeg/runtime-cloudflare/jobs';
import {complexCommandGraph,complexCommandBudget} from '../helpers/complex-command-graph.js';
export {MediaWorkflow} from '@edge-ffmpeg/runtime-cloudflare/jobs/workflow';
export {MediaJobCoordinator} from '@edge-ffmpeg/runtime-cloudflare/jobs/durable-object';
async function body(request:Request):Promise<unknown>{const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let length=0;if(reader)try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>262144){await reader.cancel();throw RangeError('Fixture request limit');}chunks.push(next.value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));}
export default {
 async queue(batch:MessageBatch<MediaJobMessage>,env:MediaWorkflowEnv){
  // Test-only delivery hold proves queued-peer failure cancellation deterministically.
  const messages=batch.messages.filter(message=>{if(message.body.jobId===mediaWorkflowJobId('failed','b')||message.body.jobId===mediaWorkflowJobId('conflict','a')||message.body.jobId===mediaWorkflowJobId('cancel-foreign','a')||['a','b'].some(node=>message.body.jobId===mediaWorkflowJobId('cancel-external',node))){message.retry({delaySeconds:1});return false;}return true;});
  await consumeMediaJobs({messages},{bucket:env.MEDIA_BUCKET,implementationVersion:'test-v1',coordinatorFor:jobId=>env.JOBS.getByName(jobId),backend:()=>{
   const backend=createMediaBackend();return {async execute(command:Parameters<typeof backend.execute>[0],context:Parameters<typeof backend.execute>[1]){
    const id=crypto.randomUUID(),started=Date.now(),path=command.outputs[0]!.url;
    await env.MEDIA_BUCKET.put('metrics/'+id,JSON.stringify({path,started,ended:null}));
    try{await new Promise<void>((resolve,reject)=>{const finish=()=>{context.signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(finish,80);const abort=()=>{clearTimeout(timer);context.signal.removeEventListener('abort',abort);reject(context.signal.reason);};context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();});return await backend.execute(command,context);}
    finally{await env.MEDIA_BUCKET.put('metrics/'+id,JSON.stringify({path,started,ended:Date.now()}));}
   }};
  }});
 },
 async fetch(request:Request,env:MediaWorkflowEnv):Promise<Response>{
  try{
   const url=new URL(request.url),id=url.searchParams.get('id')??'test';
   if(url.pathname==='/cancel'){const spec=await body(request) as MediaWorkflowSpec;try{return Response.json({ok:true,result:await cancelMediaWorkflow(spec,{workflow:env.MEDIA_WORKFLOW,JOBS:env.JOBS})});}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error),details:typeof error==='object'&&error!==null&&'details'in error?error.details:null});}}
   if(url.pathname==='/single'){const {args}=await body(request) as {args:string[]};const filesystem=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'source','/output':'baseline'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'baseline-stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:1048576}});return Response.json(await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args));}
   if(url.pathname==='/finalize'){const spec=await body(request) as MediaWorkflowSpec;const statuses=new Map<string,MediaJobStatus>();for(const node of spec.nodes){const status=await env.JOBS.getByName(mediaWorkflowJobId(spec.workflowId,node.id)).status();if(status)statuses.set(node.id,status);}return Response.json(await publishMediaWorkflowResult(env.MEDIA_BUCKET,spec,statuses));}
   if(url.pathname==='/node-claim'){const node=url.searchParams.get('node')!;return Response.json(await env.JOBS.getByName(mediaWorkflowJobId(id,node)).claim());}
   if(url.pathname==='/late-submit'){const {spec,nodeId,artifacts}=await body(request) as {spec:MediaWorkflowSpec;nodeId:string;artifacts:Record<string,MediaJobStatus['artifacts']>};const job=await deriveMediaJobSpec(spec,nodeId,new Map(Object.entries(artifacts))),stub=env.JOBS.getByName(job.jobId);return Response.json({status:await stub.submit(job),claim:await stub.claim()});}
   if(url.pathname==='/cancel-before-submit'){const options=await body(request) as Parameters<typeof buildMediaWorkflowSpec>[0];const spec=await buildMediaWorkflowSpec({...options,bucket:env.MEDIA_BUCKET});const job=await deriveMediaJobSpec(spec,'a',new Map()),stub=env.JOBS.getByName(job.jobId);const cancelled=await stub.cancelSubmitted(job);const late=await stub.submit(job);return Response.json({cancelled,late,claim:await stub.claim()});}
   if(url.pathname==='/prepopulate'){const options=await body(request) as Parameters<typeof buildMediaWorkflowSpec>[0];const spec=await buildMediaWorkflowSpec({...options,bucket:env.MEDIA_BUCKET});const job=await deriveMediaJobSpec(spec,'a',new Map());const foreign={...job,graphHash:'f'.repeat(64),...(job.workflow?{workflow:{...job.workflow,graphHash:'f'.repeat(64)}}:{}),args:job.args.map(value=>value==='volume=0.5'?'volume=0.75':value)};return Response.json(await env.JOBS.getByName(job.jobId).submit(foreign));}
   if(url.pathname==='/create-complex'){const {mode}=await body(request) as {mode:'join'|'outputs'};if(!['join','outputs'].includes(mode))throw Error('Invalid graph mode');const {graph,registry,bindings}=complexCommandGraph(mode);const result=await buildComplexVideoGraphMediaWorkflowSpec({bucket:env.MEDIA_BUCKET,workflowId:id,graph,registry,bindings,budget:complexCommandBudget,globalArgs:['-cpuflags','0'],implementationVersion:'test-v1',maxAttempts:1,leaseMs:2000,maxParallel:1,pollIntervalMs:50,maxPolls:200});const instance=await env.MEDIA_WORKFLOW.create({id,params:result.spec});return Response.json({id:instance.id,spec:result.spec,workUnits:result.workUnits});}
   if(url.pathname==='/create-independent'){
    const registry=new FeatureRegistry<OperatorDescriptor>(),kinds=['source','decode','filter','encode','mux','sink'] as const;
    for(const kind of kinds){const input=kind==='source'?null:kind==='filter'||kind==='encode'?'audio-frame':'packet',output=kind==='sink'?null:kind==='decode'||kind==='filter'?'audio-frame':'packet';registry.register({id:kind,kind,status:'partial',runtimes:['cloudflare'],testCases:[],inputs:input?[{name:'in',type:input}]:[],outputs:output?[{name:'out',type:output}]:[],traits:{state:kind==='filter'?'stateless':'stateful',access:'sequential',checkpointable:false,temporal:kind!=='filter',deterministic:true,minimumMemoryBytes:1024,estimatedCpuTimeMs:10}});}
    const graph={nodes:['a','b'].flatMap(name=>kinds.map(kind=>({id:name+'-'+kind,featureId:kind}))),edges:['a','b'].flatMap(name=>kinds.slice(0,-1).map((kind,index)=>({from:{node:name+'-'+kind,port:'out'},to:{node:name+'-'+kinds[index+1]!,port:'in'},queueCapacity:1})))};
    const bindings=new Map<string,CommandOperatorBinding>();for(const name of ['a','b']){
     bindings.set(name+'-source',{kind:'source',path:'/input/media.raw',key:'source/media.raw',options:['-f','s16le','-ar','8000','-ac','2']});
     bindings.set(name+'-decode',{kind:'input-options',options:[]});
     bindings.set(name+'-filter',{kind:'filter',mediaType:'audio',expression:'volume=0.5'});
     bindings.set(name+'-encode',{kind:'output-options',options:['-c:a','pcm_s16le']});
     bindings.set(name+'-mux',{kind:'output-options',options:['-f','wav']});
     bindings.set(name+'-sink',{kind:'sink',path:'/output/'+name+'.wav'});
    }
    const result=await buildCommandGraphMediaWorkflowSpec({bucket:env.MEDIA_BUCKET,workflowId:id,graph,registry,bindings,budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxCpuTimeMs:15000,maxPendingPackets:8},globalArgs:['-cpuflags','0'],implementationVersion:'test-v1',maxAttempts:1,leaseMs:2000,maxParallel:2,pollIntervalMs:50,maxPolls:200});
    const instance=await env.MEDIA_WORKFLOW.create({id,params:result.spec});return Response.json({id:instance.id,spec:result.spec,workUnits:result.workUnits});
   }
   if(url.pathname==='/create'){const options=await body(request) as Parameters<typeof buildMediaWorkflowSpec>[0];const spec=await buildMediaWorkflowSpec({...options,bucket:env.MEDIA_BUCKET});const instance=await env.MEDIA_WORKFLOW.create({id,params:spec});return Response.json({id:instance.id,spec});}
   if(url.pathname==='/node-status'){const node=url.searchParams.get('node')!;return Response.json(await env.JOBS.getByName(mediaWorkflowJobId(id,node)).status());}
   if(url.pathname==='/status')return Response.json(await(await env.MEDIA_WORKFLOW.get(id)).status());
   if(url.pathname==='/job-status')return Response.json(await env.JOBS.getByName(id).status());
   return new Response('Unknown',{status:404});
  }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400});}
 }
} satisfies ExportedHandler<MediaWorkflowEnv,MediaJobMessage>;
