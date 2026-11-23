import {ResourceContext} from '@edge-ffmpeg/core';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {openFlacDemux} from '@edge-ffmpeg/containers';
const encode=new TextEncoder();
function frame(kind:number,value:Uint8Array){if(value.length>65536)throw Error('Fixture frame limit');const out=new Uint8Array(value.length+5);out[0]=kind;new DataView(out.buffer).setUint32(1,value.length);out.set(value,5);return out;}
const jsonFrame=(kind:number,value:unknown)=>frame(kind,encode.encode(JSON.stringify(value,(_key,v:unknown)=>typeof v==='bigint'?String(v):v)));
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),id=url.searchParams.get('id')??'',explode=url.searchParams.get('explode')==='1';
 if(!/^[a-z0-9-]{1,64}$/.test(id))return new Response('Invalid fixture id',{status:400});
 const controller=new AbortController(),forward=()=>controller.abort(request.signal.reason);request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 const context=new ResourceContext({maxResidentBytes:65570,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:8},controller.signal);
 let peak=0,reads=0,maximumRead=0,demux:Awaited<ReturnType<typeof openFlacDemux>>|undefined,cleanup:Promise<void>|undefined;
 const resources={budget:context.budget,get allocatedBytes(){return context.allocatedBytes;},allocate(bytes:number){const owned=context.allocate(bytes);peak=Math.max(peak,context.allocatedBytes);return owned;}};
 async function close(error?:unknown){if(!cleanup)cleanup=(async()=>{try{controller.abort(error??Error('Fixture complete'));await demux?.close();}finally{request.signal.removeEventListener('abort',forward);await env.MEDIA_BUCKET.put('metrics/'+id,JSON.stringify({owned:context.allocatedBytes,peak,reads,maximumRead,error:error instanceof Error?error.message:error===undefined?null:String(error),closed:demux?.metrics.closed??true}));}})();await cleanup;}
 try{
  const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'source'},maxReadBytes:65536}),original=await files.openRead('/input/input.flac');
  if(original.size>33554432n)throw RangeError('Fixture input size');
  const source={size:original.size,readAt(offset:bigint,length:number,signal?:AbortSignal){reads++;maximumRead=Math.max(maximumRead,length);return original.readAt(offset,length,signal);}};
  demux=await openFlacDemux(source,{resources,signal:controller.signal,maxReadBytes:65536,maxScanBytes:original.size,maxPacketBytes:33554432n,maxPictureBytes:33554432,maxMetadataBytes:33554432n,explode,strictCompliance:url.searchParams.get('strict')==='1'?1:0});
  const opened=demux;
  async function* output(){try{
   yield jsonFrame(5,opened.metadata);
   for(const picture of opened.attachedPictures){yield jsonFrame(0,{kind:'picture',descriptor:picture.descriptor});for await(const chunk of picture.chunks){let bytes:Uint8Array;try{bytes=frame(1,chunk.data);}finally{chunk.release();}yield bytes;}yield frame(2,new Uint8Array());}
   for await(const packet of opened.packets){yield jsonFrame(0,{kind:'audio',pts:packet.pts,dts:packet.dts,duration:packet.duration,range:packet.range});for await(const chunk of packet.chunks){let bytes:Uint8Array;try{bytes=frame(1,chunk.data);}finally{chunk.release();}yield bytes;}yield frame(2,new Uint8Array());}
  }finally{await close();}}
  const iterator=output();
  return new Response(new ReadableStream<Uint8Array>({async pull(out){try{const next=await iterator.next();if(next.done)out.close();else out.enqueue(next.value);}catch(error){await close(error);out.enqueue(jsonFrame(4,{error:error instanceof Error?error.message:String(error)}));out.close();}},async cancel(reason){controller.abort(reason);try{await iterator.return();}finally{await close(reason);}}}),{headers:{'content-type':'application/octet-stream'}});
 }catch(error){await close(error);return Response.json({error:error instanceof Error?error.message:String(error),owned:context.allocatedBytes},{status:422});}
}} satisfies ExportedHandler<Env>;
