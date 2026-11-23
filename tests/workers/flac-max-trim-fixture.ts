import module from './edge-flac.wasm';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {createFlacDecoder} from '@edge-ffmpeg/avcodec';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {createMediaBackend,trimFlacAudio} from '@edge-ffmpeg/avformat';

const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
const formats=['u8','u8p','s16','s16p','s32','s32p','flt','fltp','dbl','dblp'];
const modes=['normal','cancel-write','write-failure','early-return','held-abort','pending-reject','pending-resolve','return-reject','frame-budget'];

/** Test the public command pipeline without replacing the helper lifetime checks. */
async function publicCommand(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),args:unknown=JSON.parse(url.searchParams.get('args')??'null'),mode=url.searchParams.get('mode')??'normal';
 if(url.href.length>8192||!Array.isArray(args)||args.length>64||!args.every((arg:unknown)=>typeof arg==='string'&&arg.length<=512)||!['normal','cancel-write','write-failure','output-budget'].includes(mode))return new Response('Invalid public fixture request',{status:400});
 const controller=new AbortController(),forward=()=>controller.abort(request.signal.reason);
 request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 let reads=0,maxRead=0,shortReads=0,writes=0,maxWrite=0,atomicChecks=0,multipartLive=0,multipartCreated=0,multipartAborted=0;
 const previousEtag=(await env.MEDIA_BUCKET.head('output/result.raw'))?.etag??null;
 const pending:Promise<unknown>[]=[];
 const assertUnpublished=async()=>{if(((await env.MEDIA_BUCKET.head('output/result.raw'))?.etag??null)!==previousEtag)throw Error('Trim output published before commit');atomicChecks++;};
 const bucket:Env['MEDIA_BUCKET']={head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),async createMultipartUpload(key,options){
  const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let active=true;
  return {key:upload.key,uploadId:upload.uploadId,uploadPart:upload.uploadPart.bind(upload),async complete(parts){const result=await upload.complete(parts);if(active){active=false;multipartLive--;}return result;},async abort(){await upload.abort();if(active){active=false;multipartLive--;multipartAborted++;}}};
 }};
 const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'trim-stage/public',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:mode==='output-budget'?1:65536}});
 const filesystem={outputExists:files.outputExists!.bind(files),async openRead(path:string){const input=await files.openRead(path);if(input.size>1048576n)throw RangeError('Fixture input limit');return {size:input.size,readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;maxRead=Math.max(maxRead,length);if(length>17)shortReads++;return input.readAt(offset,Math.min(length,17),signal);}};},async openWrite(path:string,options?:{readonly overwrite?:boolean}){
  const output=await files.openWrite(path,options);
  return {async write(bytes:Uint8Array){writes++;maxWrite=Math.max(maxWrite,bytes.length);await assertUnpublished();if(mode==='write-failure')throw Error('Injected public trim write failure');const task=output.write(bytes);pending.push(task);await task;await assertUnpublished();if(mode==='cancel-write')controller.abort(Error('Injected public trim cancellation'));},async commit(){await assertUnpublished();await output.commit();},async abort(reason?:unknown){const task=output.abort(reason);pending.push(task);await task;}};
 }};
 try{
  const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend({flac:{module,maxReadBytes:4096,maxFrameBytes:65536}}),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:1,maxCpuTimeMs:60000}});
  const result=await ffmpeg.exec(args,{signal:controller.signal});await Promise.allSettled(pending);
  const stored=await env.MEDIA_BUCKET.get('output/result.raw');let sha256:string|null=null;
  if(stored){const digest=new crypto.DigestStream('SHA-256');await stored.body.pipeTo(digest);sha256=hex(await digest.digest);}
  return Response.json({exitCode:result.exitCode,diagnostics:result.diagnostics,outputs:result.outputs,sha256,size:stored?.size??null,reads,maxRead,shortReads,writes,maxWrite,atomicChecks,multipartLive,multipartCreated,multipartAborted,stages:(await env.MEDIA_BUCKET.list({prefix:'trim-stage/'})).objects.length});
 }finally{request.signal.removeEventListener('abort',forward);}
}

/** Test-only decoder adapter; no CLI/backend fallback or Native execution. */
export default {async fetch(request:Request,env:Env):Promise<Response>{
 if(new URL(request.url).searchParams.has('args'))return publicCommand(request,env);
 const url=new URL(request.url),mode=url.searchParams.get('mode')??'normal',format=url.searchParams.get('format')??'s32';
 if(!modes.includes(mode)||!formats.includes(format)||url.href.length>2048)return new Response('Invalid fixture request',{status:400});
 const startSample=BigInt(url.searchParams.get('start')??'0'),endSampleExclusive=url.searchParams.has('end')?BigInt(url.searchParams.get('end')!):null,outputPtsSamples=BigInt(url.searchParams.get('pts')??'0');
 const controller=new AbortController(),reason=Error('trim-fixture-'+mode),forward=()=>controller.abort(request.signal.reason);
 request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 const resources=new ResourceContext({maxResidentBytes:17825792,maxBufferBytes:65536,maxPendingPackets:1,maxCpuTimeMs:10000},controller.signal);
 let peak=0,reads=0,maxRead=0,shortReads=0,writes=0,maxWrite=0,sourceFrames=0,sourceReturns=0,sourceReleased=0,reservations=0,releases=0,multipartLive=0,multipartCreated=0,multipartAborted=0;
 const sampleWidth=format.startsWith('u8')?1:format.startsWith('s16')?2:format.startsWith('dbl')?8:4,planar=format.endsWith('p');
 const frames:{samples:number;pts:string|null;timeBase:{num:string;den:string}|null;owned:number}[]=[];
 const observe=()=>{peak=Math.max(peak,resources.allocatedBytes);};
 const originalReserve=resources.reserveExternalMemory.bind(resources);
 resources.reserveExternalMemory=bytes=>{const release=originalReserve(bytes);reservations++;observe();let alive=true;return()=>{if(alive){alive=false;releases++;release();}};};
 const bucket:Env['MEDIA_BUCKET']={head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),async createMultipartUpload(key,options){const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let active=true;return {key:upload.key,uploadId:upload.uploadId,uploadPart:upload.uploadPart.bind(upload),async complete(parts){const result=await upload.complete(parts);if(active){active=false;multipartLive--;}return result;},async abort(){await upload.abort();if(active){active=false;multipartLive--;multipartAborted++;}}};}};
 const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'trim-stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:65536}});
 let decoder:Awaited<ReturnType<typeof createFlacDecoder>>|undefined,output:Awaited<ReturnType<typeof files.openWrite>>|undefined,iterator:AsyncIterator<AudioFrameData>|undefined,error:unknown,failed=false,committed=false,lateSettled=false;
 const digest=new crypto.DigestStream('SHA-256'),digestWriter=digest.getWriter();let totalBytes=0,sampleCount=0;
 // Account the R2 adapter's worst-case buffer plus growth overlap for this fixture.
 const releaseR2=resources.reserveExternalMemory(131072);
 let settle:(()=>void)|undefined;
 async function* decoded():AsyncGenerator<AudioFrameData>{
  try{for(;;){
   const item=await decoder!.next();if(item.status==='end')return;if(item.status!=='frame')continue;sourceFrames++;
   const release=resources.reserveExternalMemory(item.samples*item.metadata.channels*sampleWidth);
   try{
    const {channels,sampleRate,bitsPerSample}=item.metadata,planeBytes=item.samples*(planar?1:channels)*sampleWidth;
    const planes=Array.from({length:planar?channels:1},()=>new Uint8Array(planeBytes));
    const views=planes.map(plane=>new DataView(plane.buffer));
    for(let sample=0;sample<item.samples;sample++)for(let channel=0;channel<channels;channel++){
     const value=item.planes[channel]![sample]!,view=views[planar?channel:0]!,offset=(planar?sample:sample*channels+channel)*sampleWidth;
     if(format.startsWith('u8'))view.setUint8(offset,Math.floor(value/2**(bitsPerSample-8))+128);
     else if(format.startsWith('s16'))view.setInt16(offset,value/2**(bitsPerSample-16),true);
     else if(format.startsWith('s32'))view.setInt32(offset,value<<32-bitsPerSample,true);
     else if(format.startsWith('flt'))view.setFloat32(offset,value/2**(bitsPerSample-1),true);
     else view.setFloat64(offset,value/2**(bitsPerSample-1),true);
    }
    observe();yield {sampleRate,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:format,samples:item.samples,planes,pts:{value:item.samplePosition,timeBase:{num:1n,den:BigInt(sampleRate)}}};
   }finally{release();item.release();sourceReleased++;}
  }}finally{sourceReturns++;}
 }
 try{
  const original=await files.openRead('/input/input.flac');if(original.size>1048576n)throw RangeError('Fixture source limit');
  decoder=await createFlacDecoder(module,{size:original.size,readAt(offset,length,signal){reads++;maxRead=Math.max(maxRead,length);if(length>17)shortReads++;return original.readAt(offset,Math.min(length,17),signal);}},{signal:controller.signal,maxReadBytes:4096,maxFrameBytes:65536,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  let source:AsyncIterable<AudioFrameData>=decoded();
  if(mode==='pending-reject'||mode==='pending-resolve'||mode==='return-reject'){
   const upstream=source[Symbol.asyncIterator]();let first=true;
   source={[Symbol.asyncIterator](){return {next(){if(mode==='return-reject'||!first)return upstream.next();first=false;const pending=new Promise<IteratorResult<AudioFrameData>>((resolve,reject)=>{settle=()=>{lateSettled=true;if(mode==='pending-reject')reject(Error('late trim source rejection'));else resolve({done:true,value:undefined});};});queueMicrotask(()=>controller.abort(reason));return pending;},async return(){const result=upstream.return?await upstream.return():{done:true as const,value:undefined};if(mode==='return-reject')throw Error('trim source return rejected');return result;}};}};
  }
  output=await files.openWrite('/output/result.raw',{overwrite:true});
  iterator=trimFlacAudio(source,{startSample,endSampleExclusive,outputPtsSamples},{resources,signal:controller.signal,maxFrameBytes:mode==='frame-budget'?1:65536})[Symbol.asyncIterator]();
  for(let steps=0;steps<4096;steps++){
   const next=await iterator.next();if(next.done){if(mode!=='early-return'&&mode!=='return-reject'){await output.commit();committed=true;}break;}
   const frame=next.value;observe();
   frames.push({samples:frame.samples,pts:frame.pts?String(frame.pts.value):null,timeBase:frame.pts?{num:String(frame.pts.timeBase.num),den:String(frame.pts.timeBase.den)}:null,owned:resources.allocatedBytes});
   if(mode==='held-abort'){controller.abort(reason);throw reason;}
   if(mode==='early-return'||mode==='return-reject'){await iterator.return?.();break;}
   for(const plane of frame.planes){
    const reserved=resources.reserveExternalMemory(plane.byteLength);
    try{writes++;maxWrite=Math.max(maxWrite,plane.byteLength);if(mode==='write-failure'&&writes===2)throw Error('Injected trim write failure');await output.write(plane);await digestWriter.write(plane);totalBytes+=plane.byteLength;if(mode==='cancel-write'){controller.abort(reason);throw reason;}}finally{reserved();}
   }
   sampleCount+=frame.samples;
   if(steps===4095)throw Error('Fixture step bound');
  }
 }catch(cause){error=cause;failed=true;}
 finally{
  try{await iterator?.return?.();}catch(cause){if(!failed){failed=true;error=cause;}}
  settle?.();await Promise.resolve();
  try{if(output&&!committed)await output.abort(error);}catch(cause){failed=true;error=cause;}
  try{await decoder?.close();}finally{releaseR2();request.signal.removeEventListener('abort',forward);await digestWriter.close();}
 }
 const stored=await env.MEDIA_BUCKET.get('output/result.raw');let storedSha256:string|null=null,storedSize:number|null=null;
 if(stored){const hash=new crypto.DigestStream('SHA-256');await stored.body.pipeTo(hash);storedSha256=hex(await hash.digest);storedSize=stored.size;}
 return Response.json({error:failed?(error instanceof Error?error.message:String(error)):null,cancelReasonPreserved:error===reason,committed,sha256:hex(await digest.digest),storedSha256,storedSize,totalBytes,sampleCount,frames,owned:resources.allocatedBytes,peak,reads,maxRead,shortReads,writes,maxWrite,sourceFrames,sourceReturns,sourceReleased,reservations,releases,memoryBytes:decoder?.memoryBytes??0,lateSettled,multipartLive,multipartCreated,multipartAborted,stages:(await env.MEDIA_BUCKET.list({prefix:'trim-stage/'})).objects.length},{status:failed?422:200});
}} satisfies ExportedHandler<Env>;
