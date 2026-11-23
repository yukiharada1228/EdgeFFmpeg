import{ResourceContext}from'@edge-ffmpeg/core';
import{createR2FileSystem,InputChangedError}from'@edge-ffmpeg/storage-r2';
import{openFlacPacketRanges,readFlacPacketChunks}from'@edge-ffmpeg/containers';
import type{FlacRangeStream,FlacIntakeRange,FlacPacketChunk}from'@edge-ffmpeg/containers';
const encoder=new TextEncoder();
function frame(kind:number,data:Uint8Array):Uint8Array{if(data.length>65536)throw Error('Fixture frame limit');const out=new Uint8Array(5+data.length);out[0]=kind;new DataView(out.buffer).setUint32(1,data.length);out.set(data,5);return out;}
function jsonFrame(kind:number,value:unknown){return frame(kind,encoder.encode(JSON.stringify(value,(_key,v:unknown)=>typeof v==='bigint'?String(v):v)));}
export default{async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),id=url.searchParams.get('id')??'',mode=url.searchParams.get('mode')??'normal';
 if(!/^[a-z0-9-]{1,64}$/.test(id)||!['normal','replace','generation','call-budget'].includes(mode))return new Response('Invalid fixture request',{status:400});
 const startText=url.searchParams.get('start')??'0',chunkText=url.searchParams.get('chunk')??'1024';if(!/^\d{1,8}$/.test(startText)||!/^\d{1,6}$/.test(chunkText))return new Response('Invalid fixture bounds',{status:400});
 const start=BigInt(startText),chunk=Number(chunkText);if(chunk<1||chunk>106496)return new Response('Invalid fixture chunk',{status:400});
 const controller=new AbortController(),forward=()=>controller.abort(request.signal.reason);request.signal.addEventListener('abort',forward,{once:true});if(request.signal.aborted)forward();
 const context=new ResourceContext({maxResidentBytes:65570,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:1},controller.signal);let peak=0,reads=0,maximumRead=0,outputBytes=0n,stream:FlacRangeStream|undefined,ranges:AsyncIterator<FlacIntakeRange>|undefined,chunks:AsyncIterator<FlacPacketChunk>|undefined,cleanupPromise:Promise<void>|undefined,mutation:{etagSame:boolean;versionChanged:boolean}|null=null;
 const resources={budget:context.budget,get allocatedBytes(){return context.allocatedBytes;},allocate(n:number){const owned=context.allocate(n);peak=Math.max(peak,context.allocatedBytes);return owned;}};
 async function cleanup(error?:unknown){if(!cleanupPromise){cleanupPromise=(async()=>{controller.abort(error??new Error('Fixture streaming complete'));stream?.close();try{await chunks?.return?.();await ranges?.return?.();}finally{request.signal.removeEventListener('abort',forward);await env.MEDIA_BUCKET.put('metrics/'+id,JSON.stringify({state:'closed',owned:context.allocatedBytes,peak,reads,maximumRead,outputBytes:String(outputBytes),mutation,error:error instanceof Error?error.message:error===undefined?null:String(error),errorCode:error instanceof InputChangedError?'input-changed':null,stream:stream?.metrics??null},(_key,v:unknown)=>typeof v==='bigint'?String(v):v));}})();}await cleanupPromise;}
 try{
  const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'source'},maxReadBytes:65536}),original=await files.openRead('/input/input.flac');if(original.size>33554432n||start>original.size)throw RangeError('Fixture source size');
  const input={size:original.size,async readAt(offset:bigint,length:number,signal?:AbortSignal){signal?.throwIfAborted();reads++;maximumRead=Math.max(maximumRead,length);
   if(reads===3&&(mode==='replace'||mode==='generation')){const before=await env.MEDIA_BUCKET.head('source/input.flac');if(!before)throw Error('Missing source');if(mode==='replace')await env.MEDIA_BUCKET.put('source/input.flac',new Uint8Array([1,2,3]));else{const body=await env.MEDIA_BUCKET.get('source/input.flac');if(!body)throw Error('Missing generation source');await env.MEDIA_BUCKET.put('source/input.flac',body.body);}const after=await env.MEDIA_BUCKET.head('source/input.flac');if(!after)throw Error('Missing mutation source');mutation={etagSame:before.etag===after.etag,versionChanged:before.version!==after.version};}
   return original.readAt(offset,length,signal);
  }};
  stream=openFlacPacketRanges(input,{startOffset:start,parserChunkBytes:chunk,signal:controller.signal,resources,maxScanBytes:original.size-start,maxParserCalls:mode==='call-budget'?1:1000000});ranges=stream[Symbol.asyncIterator]();
  const body=new ReadableStream<Uint8Array>({async pull(output){try{
   if(chunks){const part=await chunks.next();if(!part.done){try{const copy=frame(1,part.value.data);outputBytes+=BigInt(part.value.data.length);output.enqueue(copy);}finally{part.value.release();}return;}chunks=undefined;output.enqueue(frame(2,new Uint8Array()));return;}
   const next=await ranges!.next();if(next.done){await cleanup();output.enqueue(jsonFrame(3,{calls:stream!.metrics.calls,packets:stream!.metrics.packets}));output.close();return;}
   const packet=next.value;chunks=readFlacPacketChunks(input,packet,{resources,signal:controller.signal,maxReadBytes:65536,maxPacketBytes:33554432n})[Symbol.asyncIterator]();output.enqueue(jsonFrame(0,{...packet,parserCall:stream!.metrics.calls}));
  }catch(error){await cleanup(error);output.enqueue(jsonFrame(4,{error:error instanceof Error?error.message:String(error),errorCode:error instanceof InputChangedError?'input-changed':null}));output.close();}},async cancel(reason){await cleanup(new Error('Fixture consumer cancelled: '+String(reason)));}});
  return new Response(body,{headers:{'content-type':'application/octet-stream'}});
 }catch(error){await cleanup(error);return Response.json({error:error instanceof Error?error.message:String(error),owned:context.allocatedBytes},{status:422});}
}}satisfies ExportedHandler<Env>;
