import module from './edge-flac.wasm';
import {ResourceContext} from '@edge-ffmpeg/core';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {createFlacDecoder} from '@edge-ffmpeg/avcodec';
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const mode=new URL(request.url).searchParams.get('mode')??'normal';
 if(!['normal','read-abort','held-abort','checkpoint-abort','reservation-budget','frame-budget','close-held'].includes(mode))return new Response('Invalid mode',{status:400});
 const controller=new AbortController(),reason=Error('fixture-cancel-'+mode),forward=()=>controller.abort(request.signal.reason);request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 const resources=new ResourceContext({maxResidentBytes:mode==='reservation-budget'?16777215:16842752,maxBufferBytes:65536,maxCpuTimeMs:10000,maxPendingPackets:1},controller.signal);
 let decoder:Awaited<ReturnType<typeof createFlacDecoder>>|undefined,peak=0,reads=0,maxRead=0,reservations=0,releases=0,closedEarly=false,totalBytes=0;
 const frames:{samples:number;samplePosition:string}[]=[],digest=new crypto.DigestStream('SHA-256'),writer=digest.getWriter();let digestClosed=false;
 async function cleanup(){try{await decoder?.close();}finally{if(!digestClosed){digestClosed=true;await writer.close();}request.signal.removeEventListener('abort',forward);}}
 try{
  const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'source'},maxReadBytes:4096}),original=await files.openRead('/input/input.flac');if(original.size>1048576n)throw RangeError('Fixture source limit');
  const input={size:original.size,readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;maxRead=Math.max(maxRead,length);const pending=original.readAt(offset,Math.min(length,1021),signal);if(mode==='read-abort')controller.abort(reason);return pending;}};
  decoder=await createFlacDecoder(module,input,{signal:controller.signal,maxReadBytes:4096,maxFrameBytes:mode==='frame-budget'?1:65536,reserveExternalMemory(bytes){const release=resources.reserveExternalMemory(bytes);reservations++;peak=Math.max(peak,resources.allocatedBytes);let alive=true;return()=>{if(alive){alive=false;releases++;release();}};},...(mode==='checkpoint-abort'?{checkpoint(){queueMicrotask(()=>controller.abort(reason));return new Promise<void>(()=>{});}}:{})});
  let ended=false;
  for(let steps=0;steps<10000;steps++){
   const item=await decoder.next();if(item.status==='end'){ended=true;break;}if(item.status!=='frame')continue;
   try{
    frames.push({samples:item.samples,samplePosition:String(item.samplePosition)});
    if(mode==='held-abort'){controller.abort(reason);throw reason;}
    if(mode==='close-held'){await decoder.close();closedEarly=true;let released=false;try{void item.planes;}catch{released=true;}if(!released)throw Error('Closed frame remains readable');break;}
    const {channels,bitsPerSample}=item.metadata,width=bitsPerSample<=16?2:4,shift=width*8-bitsPerSample,planes=item.planes;
    for(let start=0;start<item.samples;){const count=Math.min(item.samples-start,Math.floor(65536/(channels*width))),owned=resources.allocate(count*channels*width);peak=Math.max(peak,resources.allocatedBytes);
     try{const view=new DataView(owned.data.buffer,owned.data.byteOffset,owned.data.byteLength);for(let sample=0;sample<count;sample++)for(let channel=0;channel<channels;channel++){const value=planes[channel]![start+sample]!<<shift,at=(sample*channels+channel)*width;if(width===2)view.setInt16(at,value,true);else view.setInt32(at,value,true);}await writer.write(owned.data);totalBytes+=owned.data.length;}finally{owned.release();}start+=count;
    }
   }finally{item.release();}
  }
  if(!ended&&!closedEarly)throw Error('Fixture step budget');const metadata=decoder.metadata;await cleanup();
  return Response.json({metadata:{...metadata,totalSamples:metadata?String(metadata.totalSamples):null},pcmSha256:hex(await digest.digest),frames,totalBytes,owned:resources.allocatedBytes,peak,reads,maxRead,reservations,releases,closedEarly,memoryBytes:decoder.memoryBytes});
 }catch(error){await cleanup();return Response.json({error:error instanceof Error?error.message:String(error),cancelReasonPreserved:error===reason,owned:resources.allocatedBytes,peak,reads,maxRead,reservations,releases,memoryBytes:decoder?.memoryBytes??0},{status:422});}
}} satisfies ExportedHandler<Env>;
