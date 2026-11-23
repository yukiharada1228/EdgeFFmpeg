import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {collectMediaCheckpointOrphans,finalizeMediaCheckpointOutput,loadMediaCheckpoint,mediaCheckpointCoordinatorName,prepareMediaCheckpoint} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import type {MediaCheckpointDescriptor,MediaCheckpointLease,MediaCheckpointStatus} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import {createAudioReframeState,serializeAudioReframeCheckpoint,deserializeAudioReframeCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
export {MediaCheckpointCoordinator} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object';
const left=[1,-2,300,-400,32767,-32768,7,-8],right=[-9,10,-1100,1200,-1300,1400,-1500,1600],limits={maxFrameBytes:1024};
function frame(start:number,count:number):AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:count,planes:[left,right].map(values=>{const bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,values[start+i]!,true);return bytes;}),pts:{value:123n+BigInt(start),timeBase:{num:1n,den:8000n}}};}
function packed(frame:AudioFrameData){const bytes=new Uint8Array(frame.samples*4);for(let sample=0;sample<frame.samples;sample++)for(let channel=0;channel<2;channel++)bytes.set(frame.planes[channel]!.subarray(sample*2,sample*2+2),(sample*2+channel)*2);return bytes;}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
async function json(request:Request):Promise<unknown>{const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let length=0;if(reader)try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>16384){await reader.cancel();throw Error('Fixture request limit');}chunks.push(next.value);}}finally{reader.releaseLock();}return JSON.parse(new TextDecoder().decode(concat(chunks)));}
export default {async fetch(request:Request,env:MediaCheckpointEnv):Promise<Response>{
 const url=new URL(request.url),pad=url.searchParams.get('pad')==='1',mode=url.searchParams.get('mode')??'';
 try{
  const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),value=>value.toString(16).padStart(2,'0')).join('');
  const identity={jobId:'collect-'+Number(pad),workUnitId:'audio',graphHash:await digest(new TextEncoder().encode('asetnsamples=3:'+pad)),inputFingerprint:await digest(packed(frame(0,8))),implementationVersion:'reframe-collect-v1'};
  const coordinator=env.CHECKPOINTS.getByName(await mediaCheckpointCoordinatorName(identity));await coordinator.initialize(identity);
  const journal={status:async()=>await coordinator.status() as MediaCheckpointStatus|null};
  if(url.pathname==='/status')return Response.json(await journal.status());
  if(url.pathname==='/claim')return Response.json(await coordinator.claim(Number(url.searchParams.get('leaseMs')??2000)));
  if(url.pathname==='/collect'){
   const limit=(name:string)=>url.searchParams.has(name)?Number(url.searchParams.get(name)):undefined,maxDeletes=limit('maxDeletes'),pageSize=limit('pageSize'),startAfter=url.searchParams.get('startAfter');
   return Response.json(await collectMediaCheckpointOrphans({bucket:env.MEDIA_BUCKET,journal,identity,dryRun:url.searchParams.get('dryRun')==='1',...(maxDeletes===undefined?{}:{maxDeletes}),...(pageSize===undefined?{}:{pageSize}),...(startAfter===null?{}:{startAfter})}));
  }
  if(url.pathname==='/commit'){
   const body=await json(request) as {lease:MediaCheckpointLease;descriptor:MediaCheckpointDescriptor};const status=await coordinator.commit(body.lease,body.descriptor);
   return url.searchParams.get('lostAck')==='1'?Response.json({error:'Injected lost commit acknowledgement'},{status:503}):Response.json(status);
  }
  if(url.pathname==='/prepare'){
   // Prepare the next unit from the committed head with the caller's lease. Faults wrap the real binding:
   // `lostPutAck` stores output.bin and drops the reply; `failOutput` rejects output.bin before storage.
   const {lease}=await json(request) as {lease:MediaCheckpointLease},status=await journal.status();if(!status)throw Error('Missing journal');
   const output=(key:string)=>key.endsWith('/output.bin'),bucket={get:env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET),async put(key:string,value:Uint8Array,options:R2PutOptions){if(output(key)&&mode==='failOutput')throw Error('Injected output put failure');const object=await env.MEDIA_BUCKET.put(key,value,options);if(output(key)&&mode==='lostPutAck')throw Error('Injected lost put acknowledgement');return object;}} as unknown as R2Bucket;
   const previous=status.commits.at(-1),checkpoint=previous?deserializeAudioReframeCheckpoint((await loadMediaCheckpoint(env.MEDIA_BUCKET,previous,2048)).state,limits):undefined;
   if(checkpoint&&(checkpoint.received!==status.inputPosition||BigInt(checkpoint.emitted)*4n!==BigInt(status.outputPosition)))throw Error('FIFO state and journal positions disagree');
   const state=createAudioReframeState(3,pad,limits,checkpoint),chunks:Uint8Array[]=[];
   try{
    const start=Number(status.inputPosition),count=start?8-start:4,finished=start+count===8;if(start!==0&&start!==4)throw Error('Unexpected journal input position');
    for(const emitted of state.push(frame(start,count)))chunks.push(packed(emitted));if(finished){const tail=state.finish();if(tail)chunks.push(packed(tail));}
    const bytes=concat(chunks),descriptor=await prepareMediaCheckpoint(bucket,identity,lease,{revision:status.revision+1,inputPosition:String(start+count),outputPosition:String(BigInt(status.outputPosition)+BigInt(bytes.length)),state:serializeAudioReframeCheckpoint(state.checkpoint(),limits),output:bytes.length?bytes:null,finished},2048);
    return Response.json({descriptor});
   }finally{state.dispose();}
  }
  if(url.pathname==='/load'){
   // Every committed state and output object must still verify its pins and digest.
   const status=await journal.status();if(!status)throw Error('Missing journal');const chunks:Uint8Array[]=[];for(const descriptor of status.commits){const loaded=await loadMediaCheckpoint(env.MEDIA_BUCKET,descriptor,2048);deserializeAudioReframeCheckpoint(loaded.state,limits);if(loaded.output)chunks.push(loaded.output);}return new Response(concat(chunks));
  }
  if(url.pathname==='/finalize'){
   const status=await journal.status();if(!status)throw Error('Missing journal');const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/output':'final'},maxReadBytes:1024,output:{writableMounts:['/output'],stagingPrefix:'final-stage',partBytes:5242880,maxWriteBytes:1024,maxOutputBytes:1048576}});
   const result=await finalizeMediaCheckpointOutput({bucket:env.MEDIA_BUCKET,status,filesystem:files,path:'/output/collect-'+Number(pad)+'.raw',maxObjectBytes:2048,maxWriteBytes:1024});
   return Response.json({bytes:String(result.bytes),revisions:result.revisions,outputChunks:result.outputChunks,stages:(await env.MEDIA_BUCKET.list({prefix:'final-stage/'})).objects.length});
  }
  return new Response('Unknown',{status:404});
 }catch(error){const message=(value:unknown):string=>value instanceof AggregateError?value.message+': '+value.errors.map(message).join('; '):value instanceof Error?value.message:String(value);return Response.json({error:message(error)},{status:422});}
}} satisfies ExportedHandler<MediaCheckpointEnv>;
