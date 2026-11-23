import module from './edge-flac.wasm';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {createFlacDecoder,encodePcm,getPcmFormat,isPcmCodec} from '@edge-ffmpeg/avcodec';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {compileFlacAudioFilters,processFlacAudioFilters,createMediaBackend} from '@edge-ffmpeg/avformat';

const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
const modes=['normal','cancel-write','write-failure','early-return','held-abort','pending-reject','pending-resolve','frame-budget','resident-budget','core-abort'];

/** Both the public backend and the borrowed-frame helper run inside real workerd. */
export default {async fetch(request:Request,env:Env):Promise<Response>{
 if(new URL(request.url).pathname==='/public')return publicFilters(request,env);
 const url=new URL(request.url),mode=url.searchParams.get('mode')??'normal',description=url.searchParams.get('filter')??'anull',codec=url.searchParams.get('codec')??'pcm_s16le';
 if(url.href.length>8192||!modes.includes(mode)||!isPcmCodec(codec)||!['pcm_u8','pcm_s16le','pcm_s32le','pcm_f32le','pcm_f64le'].includes(codec))return new Response('Invalid fixture request',{status:400});
 const controller=new AbortController(),coreController=new AbortController(),reason=Error('filters-fixture-'+mode),forward=()=>controller.abort(request.signal.reason);
 request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 const resources=new ResourceContext({maxResidentBytes:mode==='resident-budget'?16941056:18874368,maxBufferBytes:65536,maxPendingPackets:1,maxCpuTimeMs:10000},coreController.signal);
 let peak=0,reservations=0,releases=0,reads=0,maxRead=0,shortReads=0,writes=0,maxWrite=0,sourceFrames=0,sourceReleased=0,sourceReturns=0,multipartLive=0,multipartCreated=0,multipartAborted=0;
 const observe=()=>{peak=Math.max(peak,resources.allocatedBytes);},reserve=resources.reserveExternalMemory.bind(resources);
 resources.reserveExternalMemory=bytes=>{const release=reserve(bytes);reservations++;observe();let alive=true;return()=>{if(alive){alive=false;releases++;release();}};};
 const bucket:Env['MEDIA_BUCKET']={head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),async createMultipartUpload(key,options){const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let active=true;return {key:upload.key,uploadId:upload.uploadId,uploadPart:upload.uploadPart.bind(upload),async complete(parts){const result=await upload.complete(parts);if(active){active=false;multipartLive--;}return result;},async abort(){await upload.abort();if(active){active=false;multipartLive--;multipartAborted++;}}};}};
 const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'filters-stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:1048576}});
 let decoder:Awaited<ReturnType<typeof createFlacDecoder>>|undefined,output:Awaited<ReturnType<typeof files.openWrite>>|undefined,iterator:AsyncIterator<AudioFrameData>|undefined,error:unknown,failed=false,committed=false,lateSettled=false;
 let plan:unknown=null,sampleCount=0,totalBytes=0,settle:(()=>void)|undefined;
 const frames:{samples:number;pts:string|null;timeBase:{num:string;den:string}|null;sampleRate:number;sampleFormat:string;owned:number}[]=[];
 const digest=new crypto.DigestStream('SHA-256'),digestWriter=digest.getWriter(),releaseR2=resources.reserveExternalMemory(131072);
 async function* decoded():AsyncGenerator<AudioFrameData>{
  try{for(;;){
   const item=await decoder!.next();if(item.status==='end')return;if(item.status!=='frame')continue;sourceFrames++;
   let release:(()=>void)|undefined;
   try{
    const {channels,sampleRate,bitsPerSample}=item.metadata;
    release=resources.reserveExternalMemory(item.samples*channels*4);
    const packed=new Uint8Array(item.samples*channels*4),view=new DataView(packed.buffer);
    for(let sample=0;sample<item.samples;sample++)for(let channel=0;channel<channels;channel++)view.setInt32((sample*channels+channel)*4,item.planes[channel]![sample]!<<(32-bitsPerSample),true);
    observe();yield {sampleRate,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:'s32',samples:item.samples,planes:[packed],pts:{value:item.samplePosition,timeBase:{num:1n,den:BigInt(sampleRate)}}};
   }finally{release?.();item.release();sourceReleased++;}
  }}finally{sourceReturns++;}
 }
 try{
  const compiled=compileFlacAudioFilters(description,getPcmFormat(codec).sampleFormat),original=await files.openRead('/input/input.flac');
  if(original.size>1048576n)throw RangeError('Fixture source limit');
  decoder=await createFlacDecoder(module,{size:original.size,readAt(offset,length,signal){reads++;maxRead=Math.max(maxRead,length);if(length>29)shortReads++;return original.readAt(offset,Math.min(length,29),signal);}},{signal:controller.signal,maxReadBytes:4096,maxFrameBytes:65536,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  const initial=await decoder.next();if(initial.status!=='metadata')throw Error('Missing initial metadata');
  plan={...compiled.plan(initial.metadata.totalSamples,initial.metadata.sampleRate,'s32'),...compiled.planSamples(initial.metadata.totalSamples,initial.metadata.sampleRate,{configuredInput:true})};
  let source:AsyncIterable<AudioFrameData>=decoded();
  if(mode==='pending-reject'||mode==='pending-resolve'){
   const upstream=source[Symbol.asyncIterator]();
   source={[Symbol.asyncIterator](){return {next(){const pending=new Promise<IteratorResult<AudioFrameData>>((resolve,reject)=>{settle=()=>{lateSettled=true;if(mode==='pending-reject')reject(Error('Late filter input rejection'));else resolve({done:true,value:undefined});};});queueMicrotask(()=>controller.abort(reason));return pending;},async return(){sourceReturns++;return upstream.return?upstream.return():{done:true,value:undefined};}};}};
  }
  output=await files.openWrite('/output/result.raw',{overwrite:true});
  iterator=processFlacAudioFilters(source,compiled,{resources,signal:controller.signal,maxFrameBytes:mode==='frame-budget'?1:65536,inputFormat:{sampleRate:initial.metadata.sampleRate,channels:initial.metadata.channels,channelLayout:initial.metadata.channels===1?'mono':'stereo',sampleFormat:'s32',pts:{value:0n,timeBase:{num:1n,den:BigInt(initial.metadata.sampleRate)}}}})[Symbol.asyncIterator]();
  for(let step=0;step<4096;step++){
   const next=await iterator.next();if(next.done){await output.commit();committed=true;break;}
   const frame=next.value;observe();frames.push({samples:frame.samples,pts:frame.pts?String(frame.pts.value):null,timeBase:frame.pts?{num:String(frame.pts.timeBase.num),den:String(frame.pts.timeBase.den)}:null,sampleRate:frame.sampleRate,sampleFormat:frame.sampleFormat,owned:resources.allocatedBytes});
   if(mode==='held-abort'||mode==='core-abort'){(mode==='core-abort'?coreController:controller).abort(reason);await iterator.next();throw Error('Filter ignored abort');}
   if(mode==='early-return'){await iterator.return?.();break;}
   const release=resources.reserveExternalMemory(frame.samples*frame.channels*(getPcmFormat(codec).bytesPerSample+getPcmFormat(codec).frameBytesPerSample));
   try{
    const packet=encodePcm(frame,codec,{maxFrameBytes:65536,signal:controller.signal});
    writes++;maxWrite=Math.max(maxWrite,packet.data.byteLength);if(mode==='write-failure'&&writes===2)throw Error('Injected filter write failure');
    await output.write(packet.data);await digestWriter.write(packet.data);totalBytes+=packet.data.byteLength;sampleCount+=frame.samples;
    if(mode==='cancel-write'){controller.abort(reason);throw reason;}
   }finally{release();}
   if(step===4095)throw Error('Fixture step bound');
  }
 }catch(cause){failed=true;error=cause;}
 finally{
  try{await iterator?.return?.();}catch(cause){if(!failed){failed=true;error=cause;}}
  settle?.();await Promise.resolve();
  try{if(output&&!committed)await output.abort(error);}catch(cause){failed=true;error=cause;}
  try{await decoder?.close();}finally{releaseR2();request.signal.removeEventListener('abort',forward);await digestWriter.close();}
 }
 const stored=await env.MEDIA_BUCKET.get('output/result.raw');let storedSha256:string|null=null,storedSize:number|null=null;
 if(stored){const hash=new crypto.DigestStream('SHA-256');await stored.body.pipeTo(hash);storedSha256=hex(await hash.digest);storedSize=stored.size;}
 return new Response(JSON.stringify({error:failed?(error instanceof Error?error.message:String(error)):null,cancelReasonPreserved:error===reason,committed,plan,sha256:hex(await digest.digest),storedSha256,storedSize,sampleCount,totalBytes,frames,owned:resources.allocatedBytes,peak,reservations,releases,reads,maxRead,shortReads,writes,maxWrite,sourceFrames,sourceReleased,sourceReturns,memoryBytes:decoder?.memoryBytes??0,lateSettled,multipartLive,multipartCreated,multipartAborted,stages:(await env.MEDIA_BUCKET.list({prefix:'filters-stage/'})).objects.length},(_key,value:unknown)=>typeof value==='bigint'?String(value):value),{status:failed?422:200,headers:{'content-type':'application/json'}});
}} satisfies ExportedHandler<Env>;

async function publicFilters(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),args:unknown=JSON.parse(url.searchParams.get('args')??'null'),mode=url.searchParams.get('mode')??'normal';
 if(url.href.length>8192||!Array.isArray(args)||args.length>64||!args.every((arg:unknown)=>typeof arg==='string'&&arg.length<=512)||!['normal','cancel-write','write-failure','output-budget'].includes(mode))return new Response('Invalid public fixture request',{status:400});
 const controller=new AbortController(),reason=Error('Public filter '+mode),forward=()=>controller.abort(request.signal.reason);
 request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 let reads=0,maxRead=0,writes=0,maxWrite=0,opens=0,aborts=0;
 const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'source','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'filters-stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:mode==='output-budget'?1:1048576}});
 const filesystem={outputExists:files.outputExists!.bind(files),async openRead(path:string){const source=await files.openRead(path);if(source.size>1048576n)throw RangeError('Fixture source limit');return {size:source.size,readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;maxRead=Math.max(maxRead,length);return source.readAt(offset,Math.min(length,29),signal);}};},async openWrite(path:string,options?:{readonly overwrite?:boolean}){opens++;const output=await files.openWrite(path,options);return {async write(bytes:Uint8Array){writes++;maxWrite=Math.max(maxWrite,bytes.length);if(mode==='write-failure'&&writes===2)throw reason;await output.write(bytes);if(mode==='cancel-write')controller.abort(reason);},commit:output.commit.bind(output),async abort(cause?:unknown){aborts++;await output.abort(cause);}};}};
 try{
  const ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend({flac:{module,maxReadBytes:4096,maxFrameBytes:65536}}),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:1,maxCpuTimeMs:10000}});
  const result=await ffmpeg.exec(args,{signal:controller.signal});
  const stored=await env.MEDIA_BUCKET.get('output/result.raw');let sha256:string|null=null;
  if(stored){const digest=new crypto.DigestStream('SHA-256');await stored.body.pipeTo(digest);sha256=hex(await digest.digest);}
  return Response.json({exitCode:result.exitCode,diagnostics:result.diagnostics,outputs:result.outputs,sha256,size:stored?.size??null,reads,maxRead,writes,maxWrite,opens,aborts,stages:(await env.MEDIA_BUCKET.list({prefix:'filters-stage/'})).objects.length});
 }finally{request.signal.removeEventListener('abort',forward);}
}
