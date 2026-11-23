import module from './edge-flac.wasm';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {OwnedBuffer,WriteHandle} from '@edge-ffmpeg/core';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {decodeFlacAudioFrames,prepareFlacAudioFrames} from '../../packages/avformat/src/flac-wave-frames.js';
import {openOutputGroup} from '../../packages/avformat/src/output-group.js';

const MODES=['normal','eager','split','prepare-only','return','throw','held-abort','resource-abort','pending-read-abort','late-read-failure','reservation-budget','frame-budget','write-failure','cancel-write','late-write-failure'];
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
const adler=(bytes:Uint8Array)=>{let a=0,b=0;for(const byte of bytes){a=(a+byte)%65521;b=(b+a)%65521;}return '0x'+((b*65536+a)>>>0).toString(16).padStart(8,'0');};
const json=(value:unknown)=>new Response(JSON.stringify(value,(_key,item:unknown)=>typeof item==='bigint'?String(item):item),{headers:{'content-type':'application/json'}});

export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),mode=url.searchParams.get('mode')??'normal',limitText=url.searchParams.get('frames')??'all';
 if(!MODES.includes(mode)||!['all','0','1'].includes(limitText))return new Response('Invalid fixture mode',{status:400});
 const limit=limitText==='all'?null:Number(limitText),controller=new AbortController(),resourceController=new AbortController(),reason=Error('flac-max-frames-'+mode),forward=()=>controller.abort(request.signal.reason);
 request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 let peak=0,reservations=0,releases=0,decoderLive=0,maxDecoderLive=0,reads=0,maxRead=0,maxReturned=0,writes=0,maxWrite=0,multipartCreated=0,multipartLive=0,aborts=0,lateSettled=0,precommitChecks=0;
 const maxBufferBytes=mode==='split'?256:65536,maxReadBytes=4096,pending:Promise<unknown>[]=[];
 class TrackedResources extends ResourceContext {
  override reserveExternalMemory(bytes:number):()=>void {
   const release=super.reserveExternalMemory(bytes);peak=Math.max(peak,this.allocatedBytes);
   if(bytes===16777216){reservations++;decoderLive++;maxDecoderLive=Math.max(maxDecoderLive,decoderLive);}
   let alive=true;return()=>{if(!alive)return;alive=false;release();if(bytes===16777216){releases++;decoderLive--;}};
  }
  override allocate(bytes:number):OwnedBuffer {const owned=super.allocate(bytes);peak=Math.max(peak,this.allocatedBytes);return owned;}
 }
 const resources=new TrackedResources({maxResidentBytes:mode==='reservation-budget'?16777215:16912384,maxBufferBytes,maxCpuTimeMs:30000,maxPendingPackets:4},resourceController.signal);
 const bucket:Env['MEDIA_BUCKET']={head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),async createMultipartUpload(key,options){
  const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let alive=true;
  return {key:upload.key,uploadId:upload.uploadId,uploadPart:upload.uploadPart.bind(upload),async complete(parts){const result=await upload.complete(parts);if(alive){alive=false;multipartLive--;}return result;},async abort(){await upload.abort();if(alive){alive=false;multipartLive--;}}};
 }};
 const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes,output:{writableMounts:['/output'],stagingPrefix:'stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:4096}});
 let group:Awaited<ReturnType<typeof openOutputGroup>>|undefined,releaseOutputStorage:(()=>void)|undefined;
 let source:ReturnType<typeof decodeFlacAudioFrames>|undefined,output:WriteHandle|undefined,error:unknown,failed=false,completed=false,returned=false,thrown=false,lazy=false,preparedOwned=0,heldOwned=0,afterReleaseOwned:number|null=null,armed=false,totalBytes=0;
 const frames:{samples:number;pts:string|null;num:string|null;den:string|null;sampleFormat:string;channelLayout:string;channels:number;sampleRate:number;bytes:number;checksum:string}[]=[];
 let metadata:unknown=null;
 async function unchanged(){const object=await env.MEDIA_BUCKET.get('output/result.raw');if(!object||await object.text()!=='previous-output')throw Error('Output published before successful completion');precommitChecks++;}
 function lateFailure():Promise<Uint8Array>{
  const task=new Promise<Uint8Array>((_resolve,reject)=>{queueMicrotask(()=>controller.abort(reason));setTimeout(()=>{lateSettled++;reject(Error('Late reader provider failure'));},0);});pending.push(task);return task;
 }
 try{
  const original=await files.openRead('/input/input.flac');if(original.size>524288n)throw RangeError('Fixture input bound');
  const reader={size:original.size,readAt(offset:bigint,length:number,signal?:AbortSignal){
   reads++;maxRead=Math.max(maxRead,length);
   if(armed&&(mode==='late-read-failure'||mode==='pending-read-abort')){armed=false;if(mode==='late-read-failure')return lateFailure();const task=new Promise<Uint8Array>((_resolve,reject)=>{queueMicrotask(()=>controller.abort(reason));setTimeout(()=>{lateSettled++;reject(reason);},0);});pending.push(task);return task;}
   const task=original.readAt(offset,Math.min(length,mode==='late-read-failure'||mode==='pending-read-abort'?17:127),signal);
   return task.then(bytes=>{maxReturned=Math.max(maxReturned,bytes.length);return bytes;});
  }};
  const options={resources,signal:controller.signal,maxReadBytes,maxFrameBytes:mode==='frame-budget'?1:65536};
  if(mode==='eager')source=await prepareFlacAudioFrames(module,reader,options);
  else {source=decodeFlacAudioFrames(module,reader,options);lazy=reads===0&&resources.allocatedBytes===0;}
  metadata=await source.prepare();preparedOwned=resources.allocatedBytes;
  if(mode==='prepare-only'){await source.close();completed=true;}
  else {
   group=await openOutputGroup(files,['/output/result.raw'],true,controller.signal);output=group.writers[0]!;
   armed=mode==='late-read-failure'||mode==='pending-read-abort';
   let count=0;
   if(limit===0){await source.return!();returned=true;}
   else for await(const frame of source){
    const bytes=frame.planes[0];if(frame.planes.length!==1||!bytes)throw Error('Expected one packed PCM plane');
    frames.push({samples:frame.samples,pts:frame.pts?String(frame.pts.value):null,num:frame.pts?String(frame.pts.timeBase.num):null,den:frame.pts?String(frame.pts.timeBase.den):null,sampleFormat:frame.sampleFormat,channelLayout:frame.channelLayout,channels:frame.channels,sampleRate:frame.sampleRate,bytes:bytes.length,checksum:adler(bytes)});
    heldOwned=Math.max(heldOwned,resources.allocatedBytes);totalBytes+=bytes.length;
    if(mode==='return'){returned=true;break;}
    if(mode==='throw'){thrown=true;throw reason;}
    if(mode==='held-abort'||mode==='resource-abort'){
     if(mode==='held-abort')controller.abort(reason);else resourceController.abort(reason);
     await source.close();afterReleaseOwned=resources.allocatedBytes;throw reason;
    }
    // Charge the bounded R2 staging buffer before its first allocation.
    releaseOutputStorage??=resources.reserveExternalMemory(4096);
    writes++;maxWrite=Math.max(maxWrite,bytes.length);await output.write(bytes);await unchanged();
    if(mode==='write-failure')throw Error('Injected failed PCM consumer write');
    if(mode==='cancel-write'){controller.abort(reason);throw reason;}
    if(mode==='late-write-failure'){
     const task=new Promise<void>((_resolve,reject)=>{queueMicrotask(()=>controller.abort(reason));setTimeout(()=>{lateSettled++;reject(Error('Late writer provider failure'));},0);});pending.push(task);
     await new Promise<void>((resolve,reject)=>{const abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});void task.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));});
    }
    count++;if(limit!==null&&count>=limit){returned=true;break;}
   }
   await source.close();
   if(mode==='return'){aborts++;await group.abort();}
   else {controller.signal.throwIfAborted();await output.commit();await unchanged();await group.commit();completed=true;}
  }
 }catch(cause){failed=true;error=cause;}
 finally{
  try{await source?.close();}catch(cause){if(!failed){failed=true;error=cause;}}
  if(group&&!completed){aborts++;try{await group.abort(error);}catch(cause){if(!failed){failed=true;error=cause;}}}
  releaseOutputStorage?.();
  await Promise.allSettled(pending);request.signal.removeEventListener('abort',forward);
 }
 const final=await env.MEDIA_BUCKET.get('output/result.raw');let sha256:string|null=null,size:number|null=null;
 if(final){const digest=new crypto.DigestStream('SHA-256');size=final.size;await final.body.pipeTo(digest);sha256=hex(await digest.digest);}
 return json({ok:!failed,error:failed?(error instanceof Error?error.message:String(error)):null,cancelReasonPreserved:failed&&error===reason,metadata,frames,totalBytes,size,sha256,owned:resources.allocatedBytes,peak,preparedOwned,heldOwned,afterReleaseOwned,reservations,releases,decoderLive,maxDecoderLive,reads,maxRead,maxReturned,writes,maxWrite,multipartCreated,multipartLive,aborts,lateSettled,precommitChecks,lazy,completed,returned,thrown,stages:(await env.MEDIA_BUCKET.list({prefix:'stage/'})).objects.length});
}} satisfies ExportedHandler<Env>;
