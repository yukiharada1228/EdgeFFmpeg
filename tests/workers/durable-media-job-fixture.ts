import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {buildMediaJobSpec,runMediaJob,consumeMediaJobs} from '@edge-ffmpeg/runtime-cloudflare/jobs';
import type {MediaJobCoordinatorClient,MediaJobMessage,MediaJobSpec,MediaJobLease,MediaJobArtifact} from '@edge-ffmpeg/runtime-cloudflare/jobs';
export {MediaJobCoordinator} from '@edge-ffmpeg/runtime-cloudflare/jobs/durable-object';
function executionOptions(env:MediaJobEnv,mode='normal'){
 return {bucket:env.MEDIA_BUCKET,implementationVersion:mode==='version-mismatch'?'other-version':'test-v1',backend:()=>{
  const backend=createMediaBackend();
  return {async execute(command:Parameters<typeof backend.execute>[0],context:Parameters<typeof backend.execute>[1]){
   if(mode==='cancel-race')await env.JOBS.getByName('cancel-race').cancel();
   return backend.execute(command,context);
  }};
 },coordinatorFor:(jobId:string):MediaJobCoordinatorClient=>{
  const stub=env.JOBS.getByName(jobId);
  if(mode!=='lost-success')return stub;
  return {submit:spec=>stub.submit(spec),claim:()=>stub.claim(),heartbeat:lease=>stub.heartbeat(lease),check:lease=>stub.check(lease),cancel:()=>stub.cancel(),fail:(lease,error,options)=>stub.fail(lease,error,options),status:()=>stub.status(),async succeed(lease,artifacts){await stub.succeed(lease,artifacts);throw Error('Injected lost success reply');}};
 }};
}
const budget={maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:15000};
async function single(env:MediaJobEnv,args:readonly string[]){
 const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'source','/output':'baseline'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'baseline-stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:1048576}});
 return new FFmpeg({filesystem:files,backend:createMediaBackend(),budget}).exec(args);
}
export default {
 async queue(batch:MessageBatch<MediaJobMessage>,env:MediaJobEnv){if(env.AUTO_RUN==='yes')await consumeMediaJobs(batch,executionOptions(env));else batch.ackAll();},
 async fetch(request:Request,env:MediaJobEnv):Promise<Response>{
  try{
   const url=new URL(request.url),jobId=url.searchParams.get('jobId')??'test';
   if(request.headers.get('content-length')&&Number(request.headers.get('content-length'))>16384)return new Response('Too large',{status:413});
   const reader=request.body?.getReader(),parts:Uint8Array[]=[];let size=0;
   if(reader)try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>16384){await reader.cancel();return new Response('Too large',{status:413});}parts.push(next.value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
   const body=JSON.parse(new TextDecoder().decode(bytes)) as {spec?:MediaJobSpec;lease?:MediaJobLease;artifacts?:MediaJobArtifact[];args?:string[];error?:string;retryable?:boolean;mode?:string;leaseMs?:number};
   const job=env.JOBS.getByName(jobId);let result:unknown;
   switch(url.pathname){
    case '/build':result=await buildMediaJobSpec({bucket:env.MEDIA_BUCKET,jobId,args:body.args!,inputs:[{path:'/input/media.raw',key:'source/media.raw'}],outputs:[{path:'/output/media.wav'}],budget,implementationVersion:'test-v1',leaseMs:body.leaseMs??1000,maxAttempts:2});break;
    case '/consume':result=await runMediaJob(jobId,executionOptions(env,body.mode));break;
    case '/status':result=await job.status();break;
    case '/submit':result=await job.submit(body.spec!);break;
    case '/claim':result=await job.claim();break;
    case '/check':result=await job.check(body.lease!);break;
    case '/heartbeat':result=await job.heartbeat(body.lease!);break;
    case '/cancel':result=await job.cancel();break;
    case '/succeed':result=await job.succeed(body.lease!,body.artifacts!);break;
    case '/fail':result=await job.fail(body.lease!,body.error??'Injected failure',{retryable:body.retryable??true});break;
    case '/single':result=await single(env,body.args!);break;
    default:return new Response('Unknown',{status:404});
   }
   return Response.json({ok:true,result});
  }catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error)});}
 }
} satisfies ExportedHandler<MediaJobEnv,MediaJobMessage>;
