import module from './edge-flac.wasm';
import {FFmpeg,ResourceContext} from '@edge-ffmpeg/core';
import {createFlacDecoder} from '@edge-ffmpeg/avcodec';
import {openFlacDemux} from '@edge-ffmpeg/containers';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {executeFlacRemux} from '../../packages/avformat/src/flac-wave-remux.js';
import {createMediaBackend} from '@edge-ffmpeg/avformat';

const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
const modes=['normal','read-abort','cancel-write','write-failure','late-write-failure','output-budget','part-failure'] as const;

export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),mode=url.searchParams.get('mode')??'normal',action=url.searchParams.get('action')??'execute';
 if(url.href.length>8192||!modes.some(value=>value===mode)||!['execute','inspect'].includes(action))return new Response('Invalid fixture request',{status:400});
 const shortRead=Number(url.searchParams.get('shortRead')??1021),route=url.searchParams.get('route')??'public';
 if(![1,7,1021].includes(shortRead)||!['public','helper'].includes(route))return new Response('Invalid fixture transport',{status:400});
 const controller=new AbortController(),reason=Error('Injected remux '+mode),forward=()=>controller.abort(request.signal.reason);
 request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 let reads=0,maxRead=0,maxReturned=0,writes=0,maxWrite=0,opens=0,aborts=0,activeWrites=0,maxActiveWrites=0,multipartLive=0,multipartCreated=0,multipartParts=0,atomic=true;
 const pending:Promise<unknown>[]=[],initial=await env.MEDIA_BUCKET.head('output/result.flac');
 const bucket:Env['MEDIA_BUCKET']={
  head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),
  async createMultipartUpload(key,options){
   const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let live=true;
   const done=()=>{if(live){live=false;multipartLive--;}};
   return {key:upload.key,uploadId:upload.uploadId,
    async uploadPart(number,value,options){multipartParts++;if(mode==='part-failure')throw reason;return upload.uploadPart(number,value,options);},
    async complete(parts){const result=await upload.complete(parts);done();return result;},async abort(){await upload.abort();done();}};
  }
 };
 const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes:65536,output:{writableMounts:['/output'],stagingPrefix:'stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:mode==='output-budget'?1:1048576}});
 const filesystem={outputExists:files.outputExists!.bind(files),async openRead(path:string){
  const source=await files.openRead(path);if(source.size>1048576n)throw RangeError('Fixture input limit');
  return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){
   reads++;maxRead=Math.max(maxRead,length);const task=source.readAt(offset,Math.min(length,shortRead),signal);
   if(mode==='read-abort')controller.abort(reason);const bytes=await task;maxReturned=Math.max(maxReturned,bytes.length);return bytes;
  }};
 },async openWrite(path:string,options?:{readonly overwrite?:boolean}){
  opens++;const writer=await files.openWrite(path,options);
  return {async write(bytes:Uint8Array){
   writes++;maxWrite=Math.max(maxWrite,bytes.length);activeWrites++;maxActiveWrites=Math.max(maxActiveWrites,activeWrites);
   const task=(async()=>{
    const visible=await env.MEDIA_BUCKET.head('output/result.flac');if((visible?.etag??null)!==(initial?.etag??null))atomic=false;
    if(mode==='write-failure'&&writes===2)throw reason;
    await writer.write(bytes);
    if(mode==='cancel-write')controller.abort(reason);
    if(mode==='late-write-failure'){controller.abort(reason);await new Promise<void>((_resolve,reject)=>setTimeout(()=>reject(reason),10));}
   })();pending.push(task);
   try{await task;}finally{activeWrites--;}
  },commit:writer.commit.bind(writer),async abort(error?:unknown){aborts++;const task=writer.abort(error);pending.push(task);await task;}};
 }};
 try{
  if(action==='inspect'){
   const path=url.searchParams.get('path');if(!['/input/input.flac','/input/native.flac','/output/result.flac'].includes(path??''))return new Response('Invalid inspection path',{status:400});
   const resources=new ResourceContext({maxResidentBytes:17825792,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:60000},controller.signal);
   let demux:Awaited<ReturnType<typeof openFlacDemux>>|undefined,decoder:Awaited<ReturnType<typeof createFlacDecoder>>|undefined,peak=0;
   const source=await filesystem.openRead(path!);
   const allocator={budget:resources.budget,allocate(bytes:number){const owned=resources.allocate(bytes);peak=Math.max(peak,resources.allocatedBytes);return owned;}};
   try{
    demux=await openFlacDemux(source,{resources:allocator,signal:controller.signal,maxReadBytes:4096,maxScanBytes:source.size,maxPacketBytes:source.size,maxMetadataBytes:1048576n,maxPictureBytes:65536,maxPendingPackets:8});
    const metadata=demux.metadata,packets=[];
    if(metadata.kind!=='flac-streaminfo')throw Error('Expected STREAMINFO');
    const streaminfo=metadata.blocks.find(block=>block.type===0);if(!streaminfo)throw Error('Missing STREAMINFO');
    let extradata='';for(let at=0;at<34;){const bytes=await source.readAt(streaminfo.payloadOffset+BigInt(at),34-at,controller.signal);if(!bytes.length)throw Error('Truncated STREAMINFO');extradata+=hex(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length) as ArrayBuffer);at+=bytes.length;}
    for await(const packet of demux.packets){
     if(packets.length>=4096)throw Error('Fixture packet limit');const digest=new crypto.DigestStream('SHA-256'),writer=digest.getWriter();let size=0;
     for await(const chunk of packet.chunks)try{size+=chunk.data.length;await writer.write(chunk.data);}finally{chunk.release();}
     await writer.close();packets.push({sha256:hex(await digest.digest),size,pts:packet.pts===null?null:String(packet.pts),dts:packet.dts===null?null:String(packet.dts),duration:packet.duration===null?null:String(packet.duration)});
    }
    await demux.close();
    let pcmSha256:string|null=null,samples='0';const frames:{samples:number;samplePosition:string}[]=[];
    if(url.searchParams.get('decode')==='1'){
     const digest=new crypto.DigestStream('SHA-256'),writer=digest.getWriter();let count=0n;
     decoder=await createFlacDecoder(module,source,{signal:controller.signal,maxReadBytes:4096,maxFrameBytes:65536,reserveExternalMemory(bytes){const release=resources.reserveExternalMemory(bytes);peak=Math.max(peak,resources.allocatedBytes);return release;}});
     try{for(let steps=0;;steps++){
      if(steps>=10000)throw Error('Fixture decode step limit');const frame=await decoder.next();if(frame.status==='end')break;if(frame.status!=='frame')continue;
      try{frames.push({samples:frame.samples,samplePosition:String(frame.samplePosition)});count+=BigInt(frame.samples);
       for(let at=0;at<frame.samples;){const n=Math.min(frame.samples-at,Math.floor(65536/(frame.metadata.channels*4))),owned=allocator.allocate(n*frame.metadata.channels*4);
        try{const view=new DataView(owned.data.buffer);for(let sample=0;sample<n;sample++)for(let channel=0;channel<frame.metadata.channels;channel++)view.setInt32((sample*frame.metadata.channels+channel)*4,frame.planes[channel]![at+sample]!,true);await writer.write(owned.data);}finally{owned.release();}at+=n;
       }
      }finally{frame.release();}
     }}finally{await writer.close();await decoder.close();}
     pcmSha256=hex(await digest.digest);samples=String(count);
    }
    await decoder?.close();await demux.close();
    return Response.json({extradata,tags:metadata.tags,packets,frames,pcmSha256,samples,owned:resources.allocatedBytes,peak,reads,maxRead,maxReturned});
   }finally{await decoder?.close();await demux?.close();if(resources.allocatedBytes!==0)throw Error('Inspection resource leak: '+resources.allocatedBytes);}
  }
  const args:unknown=JSON.parse(url.searchParams.get('args')??'null');
  if(!Array.isArray(args)||args.length>64||!args.every((value:unknown)=>typeof value==='string'&&value.length<=512))return new Response('Invalid fixture argv',{status:400});
  const backend=route==='helper'?{execute:executeFlacRemux}:createMediaBackend({flac:{module,maxReadBytes:4096,maxFrameBytes:65536}});
  const ffmpeg=new FFmpeg({filesystem,backend,budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:60000}});
  const result=await ffmpeg.exec(args,{signal:controller.signal});
  // Failed providers may settle after cancellation. Observe them before checking cleanup.
  for(let at=0;at<pending.length;at++)await Promise.allSettled([pending[at]!]);
  const deadline=Date.now()+5000;
  while(multipartLive&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  const output=await env.MEDIA_BUCKET.get('output/result.flac');let sha256:string|null=null,size:number|null=null;
  if(output){const digest=new crypto.DigestStream('SHA-256');await output.body.pipeTo(digest);sha256=hex(await digest.digest);size=output.size;}
  return Response.json({exitCode:result.exitCode,outputs:result.outputs,diagnostics:result.diagnostics,cancelled:controller.signal.aborted,size,sha256,reads,maxRead,maxReturned,writes,maxWrite,opens,aborts,maxActiveWrites,atomic,multipartLive,multipartCreated,multipartParts,stages:(await env.MEDIA_BUCKET.list({prefix:'stage/'})).objects.length});
 }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:422});}
 finally{request.signal.removeEventListener('abort',forward);}
}} satisfies ExportedHandler<Env>;
