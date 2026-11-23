import module from './edge-flac.wasm';
import {ResourceContext} from '@edge-ffmpeg/core';
import type {WriteHandle} from '@edge-ffmpeg/core';
import {createFlacDecoder} from '@edge-ffmpeg/avcodec';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {snapshotFlacSelection,selectFlacStreams} from '../../packages/avformat/src/flac-selection.js';
import type {FlacSelectionOptions,FlacStreamIdentities} from '../../packages/avformat/src/flac-selection.js';

const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const modes=['normal','cancel-write','write-failure','read-abort','output-budget','held-read-abort'] as const;
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const text=await request.text();if(text.length>16384)return new Response('Fixture request limit',{status:400});
 const body=JSON.parse(text) as {options:FlacSelectionOptions;identities:FlacStreamIdentities;argv?:string[];mode?:string;selectionOnly?:boolean;mutateAfterSnapshot?:boolean};
 const mode=body.mode??'normal';if(!modes.some(value=>value===mode))return new Response('Invalid fixture mode',{status:400});
 const controller=new AbortController(),reason=Error('selection-fixture-'+mode),forward=()=>controller.abort(request.signal.reason);
 request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 const resources=new ResourceContext({maxResidentBytes:25165824,maxBufferBytes:65536,maxPendingPackets:1,maxCpuTimeMs:10000},controller.signal);
 let reads=0,maxRead=0,maxReturned=0,writes=0,maxWrite=0,opens=0,aborts=0,commits=0,peak=0,reservations=0,releases=0,multipartLive=0,multipartCreated=0,totalBytes=0,samples=0;
 let decoder:Awaited<ReturnType<typeof createFlacDecoder>>|undefined,output:WriteHandle|undefined,error:string|undefined,code:string|undefined,cancelReasonPreserved=false;
 let selection:ReturnType<typeof selectFlacStreams>|undefined,releaseOutput:(()=>void)|undefined;
 const frames:{samples:number;samplePosition:string}[]=[],pending:Promise<unknown>[]=[];
 const bucket:Env['MEDIA_BUCKET']={head:env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),put:env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),delete:env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),list:env.MEDIA_BUCKET.list.bind(env.MEDIA_BUCKET),resumeMultipartUpload:env.MEDIA_BUCKET.resumeMultipartUpload.bind(env.MEDIA_BUCKET),async createMultipartUpload(key,options){const upload=await env.MEDIA_BUCKET.createMultipartUpload(key,options);multipartCreated++;multipartLive++;let active=true;return {key:upload.key,uploadId:upload.uploadId,uploadPart:upload.uploadPart.bind(upload),async complete(parts){const result=await upload.complete(parts);if(active){active=false;multipartLive--;}return result;},async abort(){await upload.abort();if(active){active=false;multipartLive--;}}};}};
 const files=createR2FileSystem({bucket,mounts:{'/input':'source','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:mode==='output-budget'?1:1048576}});
 if(body.argv){
  // Exercise the public parser/backend and actual demux descriptors, not oracle-fed identities.
  try{
   const filesystem={outputExists:files.outputExists!.bind(files),async openRead(path:string){const source=await files.openRead(path);return {size:source.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;maxRead=Math.max(maxRead,length);const bytes=await source.readAt(offset,Math.min(length,19),signal);maxReturned=Math.max(maxReturned,bytes.length);return bytes;}};},async openWrite(path:string,options?:{overwrite?:boolean}){opens++;const writer=await files.openWrite(path,options);return {async write(bytes:Uint8Array){writes++;maxWrite=Math.max(maxWrite,bytes.length);await writer.write(bytes);},async commit(){await writer.commit();commits++;},async abort(reason?:unknown){aborts++;await writer.abort(reason);}};}};
   const frontend=new FFmpeg({filesystem,backend:createMediaBackend({flac:{module,maxReadBytes:4096,maxFrameBytes:65536}}),budget:{maxResidentBytes:25165824,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000}});
   const result=await frontend.exec(body.argv,{signal:controller.signal});
   const stored=await env.MEDIA_BUCKET.get('output/result.pcm');let size:number|null=null,sha256:string|null=null;
   if(stored){const digest=new crypto.DigestStream('SHA-256');await stored.body.pipeTo(digest);size=stored.size;sha256=hex(await digest.digest);}
   return Response.json({exitCode:result.exitCode,diagnostics:result.diagnostics,outputs:result.outputs,reads,maxRead,maxReturned,writes,maxWrite,opens,aborts,commits,multipartLive,multipartCreated,size,sha256,stages:(await env.MEDIA_BUCKET.list({prefix:'stage/'})).objects.length});
  }finally{request.signal.removeEventListener('abort',forward);}
 }
 try{
  // Snapshot before the first provider await, exactly as production callers must.
  const policy=snapshotFlacSelection(body.options);
  if(body.mutateAfterSnapshot){const mutable=body.options as {maps:string[];audio:boolean;video:boolean;defaults:{audio:boolean;picture:string}};mutable.maps.splice(0,mutable.maps.length,'0:v');mutable.audio=false;mutable.video=false;mutable.defaults.audio=false;}
  const identities=Object.freeze({...body.identities,pictureStreamIds:Object.freeze([...body.identities.pictureStreamIds]),...(body.identities.streamDescriptors?{streamDescriptors:Object.freeze(body.identities.streamDescriptors.map(descriptor=>Object.freeze({...descriptor,...(descriptor.tags?{tags:Object.freeze({...descriptor.tags})}:{}),...(descriptor.dispositions?{dispositions:Object.freeze([...descriptor.dispositions])}:{})})))}:{})});
  selection=selectFlacStreams(policy,identities);
  if(!body.selectionOnly){
   if(selection.pictureStreamIds.length)throw Object.assign(Error('Selected attached pictures require an explicit picture muxer; none are discarded'),{code:'unsupported-command'});
   const source=await files.openRead('/input/input.flac');if(source.size>1048576n)throw RangeError('Fixture source limit');
   const input={size:source.size,readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;maxRead=Math.max(maxRead,length);if(mode==='held-read-abort'){const task=new Promise<Uint8Array>((_resolve,reject)=>{queueMicrotask(()=>{controller.abort(reason);queueMicrotask(()=>reject(Error('late read rejection')));});});pending.push(task);return task;}const task=source.readAt(offset,Math.min(length,19),signal).then(bytes=>{maxReturned=Math.max(maxReturned,bytes.length);return bytes;});pending.push(task);if(mode==='read-abort')controller.abort(reason);return task;}};
   decoder=await createFlacDecoder(module,input,{signal:controller.signal,maxReadBytes:4096,maxFrameBytes:65536,reserveExternalMemory(bytes){const release=resources.reserveExternalMemory(bytes);reservations++;peak=Math.max(peak,resources.allocatedBytes);return()=>{releases++;release();};}});
   let ended=false;
   for(let step=0;step<10000;step++){
    const item=await decoder.next();if(item.status==='end'){ended=true;break;}if(item.status!=='frame')continue;
    try{
     if(!output){releaseOutput=resources.reserveExternalMemory(5242880);peak=Math.max(peak,resources.allocatedBytes);opens++;output=await files.openWrite!('/output/result.pcm',{overwrite:true});}
     frames.push({samples:item.samples,samplePosition:String(item.samplePosition)});samples+=item.samples;
     const {channels,bitsPerSample}=item.metadata,width=bitsPerSample<=16?2:4,shift=width*8-bitsPerSample,planes=item.planes;
     for(let start=0;start<item.samples;){const count=Math.min(item.samples-start,Math.floor(65536/(channels*width))),owned=resources.allocate(count*channels*width);peak=Math.max(peak,resources.allocatedBytes);
      try{const view=new DataView(owned.data.buffer,owned.data.byteOffset,owned.data.byteLength);for(let sample=0;sample<count;sample++)for(let channel=0;channel<channels;channel++){const value=planes[channel]![start+sample]!<<shift,at=(sample*channels+channel)*width;if(width===2)view.setInt16(at,value,true);else view.setInt32(at,value,true);}writes++;maxWrite=Math.max(maxWrite,owned.data.length);if(mode==='write-failure'&&writes===2)throw Error('Injected output write failure');const task=output.write(owned.data);pending.push(task);await task;totalBytes+=owned.data.length;if(mode==='cancel-write')controller.abort(reason);controller.signal.throwIfAborted();}finally{owned.release();}start+=count;
     }
    }finally{item.release();}
   }
   if(!ended)throw Error('Fixture step budget');controller.signal.throwIfAborted();if(!output){releaseOutput=resources.reserveExternalMemory(5242880);peak=Math.max(peak,resources.allocatedBytes);opens++;output=await files.openWrite!('/output/result.pcm',{overwrite:true});}await output.commit();commits++;
  }
 }catch(caught){error=caught instanceof Error?caught.message:String(caught);code=typeof caught==='object'&&caught!==null&&'code' in caught?String(caught.code):undefined;cancelReasonPreserved=caught===reason;if(output&&!commits){aborts++;await output.abort(caught);}}
 finally{try{await decoder?.close();await Promise.allSettled(pending);}finally{releaseOutput?.();request.signal.removeEventListener('abort',forward);}}
 const stored=await env.MEDIA_BUCKET.get('output/result.pcm');let size:number|null=null,sha256:string|null=null;
 if(stored){const digest=new crypto.DigestStream('SHA-256');await stored.body.pipeTo(digest);size=stored.size;sha256=hex(await digest.digest);}
 return Response.json({selection,error,code,cancelReasonPreserved,frames,samples,totalBytes,size,sha256,reads,maxRead,maxReturned,writes,maxWrite,opens,aborts,commits,owned:resources.allocatedBytes,memoryBytes:decoder?.memoryBytes??0,peak,reservations,releases,multipartLive,multipartCreated,stages:(await env.MEDIA_BUCKET.list({prefix:'stage/'})).objects.length});
}} satisfies ExportedHandler<Env>;
