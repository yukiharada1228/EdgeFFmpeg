import {ResourceContext} from '@edge-ffmpeg/core';
import type {WriteHandle} from '@edge-ffmpeg/core';
import {parseArgv} from '@edge-ffmpeg/cli';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import {createFlacDecoder} from '@edge-ffmpeg/avcodec';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';

type Range = {readonly startSample:bigint;readonly endSampleExclusive:bigint|null;readonly outputPtsSamples:bigint};
type Compile<P> = (command:ParsedCommand)=>P;
type Resolve<P> = (policy:P,sampleRate:number,totalSamples:bigint|null)=>Range;
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
const serialize=(value:unknown)=>JSON.stringify(value,(_key,item:unknown)=>typeof item==='bigint'?String(item):item);

/** The test entry statically supplies the production helper and compiled Wasm.
 * This fixture never imports a host filesystem, a Native binary, or .build. */
export function createTimeFixture<P>(module:WebAssembly.Module,compile:Compile<P>,resolve:Resolve<P>){
 return {async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url),mode=url.searchParams.get('mode')??'normal';
  if(url.href.length>16384||!['normal','cancel-write','write-failure','output-budget','read-abort','late-read-abort'].includes(mode))return new Response('Invalid fixture request',{status:400});
  const args:unknown=JSON.parse(url.searchParams.get('args')??'null');
  if(!Array.isArray(args)||args.length>64||!args.every((item:unknown)=>typeof item==='string'&&item.length<=512))return new Response('Invalid arguments',{status:400});
  const controller=new AbortController(),reason=Error('time-fixture-'+mode),forward=()=>controller.abort(request.signal.reason);
  request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
  const resources=new ResourceContext({maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:1,maxCpuTimeMs:60000},controller.signal);
  let reads=0,maxRead=0,shortReads=0,writes=0,maxWrite=0,opens=0,aborts=0,multipartLive=0,multipartCreated=0,reservations=0,releases=0,peak=0,atomicChecks=0;
  let decoder:Awaited<ReturnType<typeof createFlacDecoder>>|undefined,output:WriteHandle|undefined,error:unknown,failed=false,published=false,emitted=0n,range:Range|undefined,unknownRange:Range|undefined,lateRejected=false;
  const pts:{pts:string;samples:number}[]=[],pending:Promise<unknown>[]=[];
  const account=(bytes:number)=>{const release=resources.reserveExternalMemory(bytes);peak=Math.max(peak,resources.allocatedBytes);return release;};
  const bucket:Env['MEDIA_BUCKET']={head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),async createMultipartUpload(key,options){
   const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let active=true;
   return {key:upload.key,uploadId:upload.uploadId,uploadPart:upload.uploadPart.bind(upload),async complete(parts){const result=await upload.complete(parts);if(active){active=false;multipartLive--;}return result;},async abort(){await upload.abort();if(active){active=false;multipartLive--;}}};
  }};
  // Charge the adapter's bounded staging capacity while the transaction is live.
  const outputLimit=mode==='output-budget'?1:1048576;
  let releaseStaging:(()=>void)|undefined;
  const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'stage/time',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:outputLimit}});
  try{
   const command=parseArgv(args),policy=compile(command),snapshot=serialize(policy);
   const previousEtag=(await env.MEDIA_BUCKET.head('output/result.raw'))?.etag??null;
   async function assertUnpublished(){
    if(((await env.MEDIA_BUCKET.head('output/result.raw'))?.etag??null)!==previousEtag)throw Error('Output changed before atomic commit');
    atomicChecks++;
   }
   // Mutating the source command must not mutate the compiled policy.
   for(const file of [...command.inputs,...command.outputs]){for(const option of file.options)if(['-ss','-t','-to'].includes(option.name))option.value='999';file.options.length=0;}
   command.inputs.length=0;command.outputs.length=0;command.global.length=0;
   const source=await files.openRead('/input/input.flac');if(source.size>1048576n)throw RangeError('Fixture input byte limit');
   decoder=await createFlacDecoder(module,{size:source.size,readAt(offset,length,signal){
    reads++;maxRead=Math.max(maxRead,length);const amount=Math.min(length,137);if(amount<length)shortReads++;
    if(mode==='late-read-abort'){
     const late=new Promise<Uint8Array>((_resolve,reject)=>setTimeout(()=>{lateRejected=true;reject(reason);},10));pending.push(late.catch(()=>{}));controller.abort(reason);return late;
    }
    const task=source.readAt(offset,amount,signal);if(mode==='read-abort')controller.abort(reason);return task;
   }},{signal:controller.signal,maxReadBytes:4096,maxFrameBytes:65536,reserveExternalMemory(bytes){const release=account(bytes);reservations++;return()=>{releases++;release();};}});
   let steps=0,ended=false;
   while(++steps<=10000){
    controller.signal.throwIfAborted();const item=await decoder.next();
    if(!range){range=resolve(policy,item.metadata.sampleRate,item.metadata.totalSamples===0n?null:item.metadata.totalSamples);unknownRange=resolve(policy,item.metadata.sampleRate,null);if(serialize(policy)!==snapshot)throw Error('Resolver mutated compiled policy');}
    if(!output){releaseStaging=account(outputLimit);output=await files.openWrite('/output/result.raw',{overwrite:true});opens++;}
    if(item.status==='end'){ended=true;break;}if(item.status!=='frame')continue;
    try{
     const first=item.samplePosition>range.startSample?item.samplePosition:range.startSample;
     const frameEnd=item.samplePosition+BigInt(item.samples),last=range.endSampleExclusive!==null&&range.endSampleExclusive<frameEnd?range.endSampleExclusive:frameEnd;
     if(last>first){
      const width=item.metadata.bitsPerSample<=16?2:4,channels=item.metadata.channels,shift=width*8-item.metadata.bitsPerSample,planes=item.planes;
      for(let start=Number(first-item.samplePosition),remaining=Number(last-first);remaining>0;){
       const count=Math.min(remaining,Math.floor(65536/(width*channels))),owned=resources.allocate(count*width*channels);peak=Math.max(peak,resources.allocatedBytes);
       try{
        const view=new DataView(owned.data.buffer,owned.data.byteOffset,owned.data.length);
        for(let sample=0;sample<count;sample++)for(let channel=0;channel<channels;channel++){const value=planes[channel]![start+sample]!<<shift,at=(sample*channels+channel)*width;if(width===2)view.setInt16(at,value,true);else view.setInt32(at,value,true);}
        controller.signal.throwIfAborted();writes++;maxWrite=Math.max(maxWrite,owned.data.length);
        if(mode==='write-failure')throw Error('Injected time output failure');
        await assertUnpublished();const task=output.write(owned.data);pending.push(task);await task;await assertUnpublished();
        pts.push({pts:String(range.outputPtsSamples+emitted),samples:count});emitted+=BigInt(count);
        if(mode==='cancel-write')controller.abort(reason);controller.signal.throwIfAborted();
       }finally{owned.release();}
       start+=count;remaining-=count;
      }
     }
     if(range.endSampleExclusive!==null&&frameEnd>=range.endSampleExclusive){ended=true;break;}
    }finally{item.release();}
   }
   if(!ended)throw Error('Fixture step limit');controller.signal.throwIfAborted();
   await decoder.close();await assertUnpublished();await output!.commit();published=true;
  }catch(cause){failed=true;error=cause;}
  finally{
   try{await decoder?.close();}catch(cause){failed=true;error??=cause;}
   await Promise.allSettled(pending);
   if(output&&!published){aborts++;try{await output.abort(error);}catch(cause){error??=cause;failed=true;}}
   releaseStaging?.();request.signal.removeEventListener('abort',forward);
  }
  const object=await env.MEDIA_BUCKET.get('output/result.raw');let size:number|null=null,sha256:string|null=null;
  if(object){size=object.size;const digest=new crypto.DigestStream('SHA-256');await object.body.pipeTo(digest);sha256=hex(await digest.digest);}
  const stages=(await env.MEDIA_BUCKET.list({prefix:'stage/time/'})).objects.map(item=>item.key);
  return new Response(serialize({exitCode:failed?1:0,error:failed?(error instanceof Error?error.message:String(error)):null,errorCode:typeof error==='object'&&error!==null&&'code' in error?error.code:null,cancelReasonPreserved:error===reason,published,size,sha256,emitted:String(emitted),range,unknownRange,pts,reads,maxRead,shortReads,writes,maxWrite,opens,aborts,multipartLive,multipartCreated,stages,owned:resources.allocatedBytes,peak,reservations,releases,memoryBytes:decoder?.memoryBytes??0,lateRejected,atomicChecks}),{headers:{'content-type':'application/json'}});
 }} satisfies ExportedHandler<Env>;
}
