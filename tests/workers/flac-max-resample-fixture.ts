import module from './edge-flac.wasm';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {createFlacDecoder} from '@edge-ffmpeg/avcodec';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {resampleFlacAudio} from '../../packages/avformat/src/flac-wave-resample.js';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';

const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
const modes=['normal','cancel-write','write-failure','early-return','held-abort','pending-reject','pending-resolve','return-reject','frame-budget','output-budget'];

/** Real decoder -> bounded helper -> transactional local R2; not the CLI backend. */
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const text=await request.text();if(text.length>4096)return new Response('Fixture request limit',{status:400});
 const body=JSON.parse(text) as {outputRate:number;targetFormat:AudioSampleFormat;mode?:string;chunkSamples?:number;pts?:string;maxFrameBytes?:number};
 const {outputRate,targetFormat}=body,mode=body.mode??'normal',chunkSamples=body.chunkSamples??73,maxFrameBytes=body.maxFrameBytes??1024;
 if(!modes.includes(mode)||!['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'].includes(targetFormat)||!Number.isSafeInteger(chunkSamples)||chunkSamples<1||chunkSamples>128||!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||maxFrameBytes>65536)return new Response('Invalid fixture request',{status:400});
 const controller=new AbortController(),reason=Error('resample-fixture-'+mode),forward=()=>controller.abort(request.signal.reason);
 request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 const resources=new ResourceContext({maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:1,maxCpuTimeMs:10000},controller.signal);
 let peak=0,reservations=0,releases=0,reads=0,maxRead=0,maxReturned=0,shortReads=0,writes=0,maxWrite=0,sourceFrames=0,sourceReleased=0,sourceReturns=0,multipartLive=0,multipartCreated=0,multipartAborted=0,lateSettled=false,committed=false,sampleCount=0,totalBytes=0;
 const observe=()=>{peak=Math.max(peak,resources.allocatedBytes);},reserve=resources.reserveExternalMemory.bind(resources);
 resources.reserveExternalMemory=bytes=>{const release=reserve(bytes);reservations++;observe();let active=true;return()=>{if(active){active=false;releases++;release();}};};
 const bucket:Env['MEDIA_BUCKET']={head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),async createMultipartUpload(key,options){const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let active=true;return {key:upload.key,uploadId:upload.uploadId,uploadPart:upload.uploadPart.bind(upload),async complete(parts){const result=await upload.complete(parts);if(active){active=false;multipartLive--;}return result;},async abort(){await upload.abort();if(active){active=false;multipartLive--;multipartAborted++;}}};}};
 const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'resample-stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:mode==='output-budget'?1:1048576}});
 // Cover the adapter's bounded growable transaction payload and copy overlap.
 const releaseR2=resources.reserveExternalMemory(2097152);
 let decoder:Awaited<ReturnType<typeof createFlacDecoder>>|undefined,output:Awaited<ReturnType<typeof files.openWrite>>|undefined,iterator:AsyncIterator<AudioFrameData>|undefined,error:unknown,failed=false,settle:(()=>void)|undefined,sourceCleanup:Promise<IteratorResult<AudioFrameData>>|undefined;
 const frames:{samples:number;pts:string|null;num:string|null;den:string|null;rate:number;format:string;bytes:number;owned:number}[]=[],digest=new crypto.DigestStream('SHA-256'),digestWriter=digest.getWriter();
 async function* decoded():AsyncGenerator<AudioFrameData>{
  try{for(;;){
   const item=await decoder!.next();if(item.status==='end')return;if(item.status!=='frame')continue;sourceFrames++;
   try{const {channels,sampleRate,bitsPerSample}=item.metadata;
    for(let at=0;at<item.samples;at+=chunkSamples){
     const width=bitsPerSample<=16?2:4;
     controller.signal.throwIfAborted();const count=Math.min(chunkSamples,item.samples-at),owned=resources.allocate(count*channels*width);observe();
     try{const view=new DataView(owned.data.buffer);for(let sample=0;sample<count;sample++)for(let channel=0;channel<channels;channel++){
      const value=item.planes[channel]![at+sample]!;
      if(width===2)view.setInt16((sample*channels+channel)*width,value<<(16-bitsPerSample),true);
      else view.setInt32((sample*channels+channel)*width,value<<(32-bitsPerSample),true);
     }
      yield {sampleRate,channels,channelLayout:channels===1?'mono':'stereo',sampleFormat:width===2?'s16':'s32',samples:count,planes:[owned.data],pts:{value:item.samplePosition+BigInt(at)+BigInt(body.pts??'0'),timeBase:{num:1n,den:BigInt(sampleRate)}}};
     }finally{owned.release();}
    }
   }finally{item.release();sourceReleased++;}
  }}finally{sourceReturns++;}
 }
 try{
  const original=await files.openRead('/input/input.flac');if(original.size>1048576n)throw RangeError('Fixture source limit');
  decoder=await createFlacDecoder(module,{size:original.size,async readAt(offset,length,signal){reads++;maxRead=Math.max(maxRead,length);const bytes=await original.readAt(offset,Math.min(length,19),signal);maxReturned=Math.max(maxReturned,bytes.length);if(bytes.length<length)shortReads++;return bytes;}},{signal:controller.signal,maxReadBytes:4096,maxFrameBytes:65536,reserveExternalMemory:bytes=>resources.reserveExternalMemory(bytes)});
  let source:AsyncIterable<AudioFrameData>=decoded();
  if(mode==='pending-reject'||mode==='pending-resolve'||mode==='return-reject'){
   const upstream=source[Symbol.asyncIterator]();let first=true;
   source={[Symbol.asyncIterator](){return {next(){if(mode==='return-reject'||!first)return upstream.next();first=false;const pending=new Promise<IteratorResult<AudioFrameData>>((resolve,reject)=>{settle=()=>{lateSettled=true;if(mode==='pending-reject')reject(Error('late resample rejection'));else resolve({done:true,value:undefined});};});queueMicrotask(()=>controller.abort(reason));return pending;},return(){sourceCleanup=(async()=>{if(mode!=='return-reject')sourceReturns++;const result=upstream.return?await upstream.return():{done:true as const,value:undefined};if(mode==='return-reject')throw Error('resample source return rejected');return result;})();return sourceCleanup;}};}};
  }
  output=await files.openWrite('/output/result.raw',{overwrite:true});
  iterator=resampleFlacAudio(source,outputRate,targetFormat,{resources,signal:controller.signal,maxFrameBytes:mode==='frame-budget'?1:maxFrameBytes})[Symbol.asyncIterator]();
  for(let step=0;step<4096;step++){
   const next=await iterator.next();if(next.done){await output.commit();committed=true;break;}
   const frame=next.value;observe();const bytes=frame.planes.reduce((sum,plane)=>sum+plane.length,0);
   if(frames.length>=256)throw Error('Fixture metadata bound');
   frames.push({samples:frame.samples,pts:frame.pts?String(frame.pts.value):null,num:frame.pts?String(frame.pts.timeBase.num):null,den:frame.pts?String(frame.pts.timeBase.den):null,rate:frame.sampleRate,format:frame.sampleFormat,bytes,owned:resources.allocatedBytes});
   if(mode==='held-abort'){controller.abort(reason);throw reason;}
   if(mode==='early-return'||mode==='return-reject'){await iterator.return?.();break;}
   for(const plane of frame.planes){
    const release=resources.reserveExternalMemory(plane.length);
    try{writes++;maxWrite=Math.max(maxWrite,plane.length);if(mode==='write-failure'&&writes===2)throw Error('Injected resample write failure');await output.write(plane);await digestWriter.write(plane);totalBytes+=plane.length;if(mode==='cancel-write'){controller.abort(reason);throw reason;}}finally{release();}
   }
   sampleCount+=frame.samples;if(step===4095)throw Error('Fixture step bound');
  }
 }catch(cause){failed=true;error=cause;}
 finally{
  try{await iterator?.return?.();}catch(cause){if(!failed){failed=true;error=cause;}}
  settle?.();await Promise.resolve();
  try{await sourceCleanup;}catch(cause){if(!failed){failed=true;error=cause;}}
  try{if(output&&!committed)await output.abort(error);}catch(cause){failed=true;error=cause;}
  try{await decoder?.close();}finally{releaseR2();request.signal.removeEventListener('abort',forward);await digestWriter.close();}
 }
 const stored=await env.MEDIA_BUCKET.get('output/result.raw');let storedSha256:string|null=null,storedSize:number|null=null;
 if(stored){const hash=new crypto.DigestStream('SHA-256');await stored.body.pipeTo(hash);storedSha256=hex(await hash.digest);storedSize=stored.size;}
 return Response.json({error:failed?(error instanceof Error?error.message:String(error)):null,cancelReasonPreserved:error===reason,committed,sha256:hex(await digest.digest),storedSha256,storedSize,totalBytes,sampleCount,frames,owned:resources.allocatedBytes,peak,reservations,releases,reads,maxRead,maxReturned,shortReads,writes,maxWrite,sourceFrames,sourceReleased,sourceReturns,memoryBytes:decoder?.memoryBytes??0,lateSettled,multipartLive,multipartCreated,multipartAborted,stages:(await env.MEDIA_BUCKET.list({prefix:'resample-stage/'})).objects.length},{status:failed?422:200});
}} satisfies ExportedHandler<Env>;
