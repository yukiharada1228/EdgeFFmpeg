import module from './edge-flac.wasm';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url);if(url.href.length>8192)return new Response('Fixture URL limit',{status:400});
 const args:unknown=JSON.parse(url.searchParams.get('args')??'null'),mode=url.searchParams.get('mode')??'normal',arithmetic=url.searchParams.get('arithmetic')??'separate';
 if(!['separate','fused'].includes(arithmetic))return new Response('Invalid arithmetic profile',{status:400});
 if(!Array.isArray(args)||args.length>64||!args.every((arg:unknown)=>typeof arg==='string'&&arg.length<=512)||!['normal','cancel-write','write-failure','output-budget','missing-module'].includes(mode))return new Response('Invalid fixture args',{status:400});
 const controller=new AbortController(),forward=()=>controller.abort(request.signal.reason);request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 let reads=0,maxRead=0,writes=0,maxWrite=0,opens=0,aborts=0,multipartLive=0,multipartCreated=0,multipartParts=0;const pending:Promise<unknown>[]=[];
 const bucket:Env['MEDIA_BUCKET']={head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),async createMultipartUpload(key,options){const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let active=true;return {key:upload.key,uploadId:upload.uploadId,async uploadPart(number,value,partOptions){const part=await upload.uploadPart(number,value,partOptions);multipartParts++;return part;},async complete(parts){const result=await upload.complete(parts);if(active){active=false;multipartLive--;}return result;},async abort(){await upload.abort();if(active){active=false;multipartLive--;}}};}};
 const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:mode==='output-budget'?1:65536}});
 const filesystem={outputExists:files.outputExists!.bind(files),async openRead(path:string){const handle=await files.openRead(path);if(handle.size>1048576n)throw RangeError('Fixture input limit');return {size:handle.size,readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;maxRead=Math.max(maxRead,length);return handle.readAt(offset,Math.min(length,1021),signal);}};},async openWrite(path:string,options?:{readonly overwrite?:boolean}){opens++;const handle=await files.openWrite(path,options);return {async write(bytes:Uint8Array){writes++;maxWrite=Math.max(maxWrite,bytes.length);if(mode==='write-failure'&&writes===2)throw Error('Injected FLAC output failure');const task=handle.write(bytes);pending.push(task);await task;if(mode==='cancel-write')controller.abort(Error('Injected FLAC output cancellation'));},commit:handle.commit.bind(handle),async abort(reason?:unknown){aborts++;const task=handle.abort(reason);pending.push(task);await task;}};}};
 try{
  const backend=createMediaBackend(mode==='missing-module'?{}:{flac:{module,maxReadBytes:4096,maxFrameBytes:65536},remixArithmetic:arithmetic==='fused'?'fused':'separate'}),ffmpeg=new FFmpeg({filesystem,backend,budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:60000}});
  const result=await ffmpeg.exec(args,{signal:controller.signal});await Promise.allSettled(pending);
  const output=await env.MEDIA_BUCKET.get('output/result.raw');let size:number|null=null,sha256:string|null=null;
  if(output){const digest=new crypto.DigestStream('SHA-256');await output.body.pipeTo(digest);size=output.size;sha256=hex(await digest.digest);}
  const stages=(await env.MEDIA_BUCKET.list({prefix:'stage/'})).objects.length;
  return Response.json({exitCode:result.exitCode,outputs:result.outputs,diagnostics:result.diagnostics,size,sha256,reads,maxRead,writes,maxWrite,opens,aborts,stages,multipartLive,multipartCreated,multipartParts,effects:'error' in result&&typeof result.error==='object'&&result.error!==null&&'effects' in result.error?result.error.effects:null});
 }finally{request.signal.removeEventListener('abort',forward);}
}} satisfies ExportedHandler<Env>;
