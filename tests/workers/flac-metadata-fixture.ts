import {ResourceContext} from '@edge-ffmpeg/core';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {readFlacMetadata} from '@edge-ffmpeg/containers';
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),cap=Number(url.searchParams.get('cap')??34),mode=url.searchParams.get('mode')??'normal';
 if(![1,34].includes(cap)||!['normal','read-abort','checkpoint-abort'].includes(mode))return new Response('Invalid request',{status:400});
 const controller=new AbortController(),reason=Error('metadata fixture cancelled');
 const context=new ResourceContext({maxResidentBytes:34,maxBufferBytes:34,maxCpuTimeMs:1000,maxPendingPackets:1},controller.signal);
 let peak=0,reads=0,maximumRead=0;
 const resources={allocate(bytes:number){const owned=context.allocate(bytes);peak=Math.max(peak,context.allocatedBytes);return owned;}};
 const forward=()=>controller.abort(request.signal.reason);request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 try{
  const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'source'},maxReadBytes:34}),original=await files.openRead('/input/input.flac');
  if(original.size>1048576n)throw RangeError('Fixture input limit');
  const source={size:original.size,readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;maximumRead=Math.max(maximumRead,length);const pending=original.readAt(offset,length,signal);if(mode==='read-abort')controller.abort(reason);return pending;}};
  const result=await readFlacMetadata(source,{resources,signal:controller.signal,maxReadBytes:cap,...(mode==='checkpoint-abort'?{checkpoint(){queueMicrotask(()=>controller.abort(reason));return new Promise<void>(()=>{});}}:{})});
  return new Response(JSON.stringify({result,owned:context.allocatedBytes,peak,reads,maximumRead},(_key,value:unknown)=>typeof value==='bigint'?String(value):value),{headers:{'content-type':'application/json'}});
 }catch(error){return Response.json({error:error instanceof Error?error.message:String(error),cancelReasonPreserved:error===reason,owned:context.allocatedBytes,peak,reads,maximumRead},{status:422});}
 finally{request.signal.removeEventListener('abort',forward);}
}} satisfies ExportedHandler<Env>;
