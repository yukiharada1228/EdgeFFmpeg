import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {finalizeMediaCheckpointOutput,prepareMediaCheckpoint,loadMediaCheckpoint,mediaCheckpointCoordinatorName} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import type {MediaCheckpointLease,MediaCheckpointDescriptor} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import {createAudioReframeState,serializeAudioReframeCheckpoint,deserializeAudioReframeCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
export {MediaCheckpointCoordinator} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object';
const left=[1,-2,300,-400,32767,-32768,7,-8],right=[-9,10,-1100,1200,-1300,1400,-1500,1600],limits={maxFrameBytes:1024};
function frame(start:number,count:number):AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:count,planes:[left,right].map(values=>{const bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,values[start+i]!,true);return bytes;}),pts:{value:123n+BigInt(start),timeBase:{num:1n,den:8000n}}};}
function packed(frame:AudioFrameData){const bytes=new Uint8Array(frame.samples*4);for(let sample=0;sample<frame.samples;sample++)for(let channel=0;channel<2;channel++)bytes.set(frame.planes[channel]!.subarray(sample*2,sample*2+2),(sample*2+channel)*2);return bytes;}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};

async function json(request:Request):Promise<unknown>{const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let length=0;if(reader)try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>16384){await reader.cancel();throw Error('Fixture request limit');}chunks.push(next.value);}}finally{reader.releaseLock();}return JSON.parse(new TextDecoder().decode(concat(chunks)));}
export default {async fetch(request:Request,env:MediaCheckpointEnv):Promise<Response>{
 const url=new URL(request.url),pad=url.searchParams.get('pad')==='1',id=url.searchParams.get('id')??'main';
 try{
  const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),value=>value.toString(16).padStart(2,'0')).join('');
  const identity={jobId:'reframe-'+id+'-'+Number(pad),workUnitId:'audio',graphHash:await digest(new TextEncoder().encode('asetnsamples=3:'+pad)),inputFingerprint:await digest(packed(frame(0,8))),implementationVersion:'reframe-v1'};
  const coordinator=env.CHECKPOINTS.getByName(await mediaCheckpointCoordinatorName(identity));await coordinator.initialize(identity);
  if(url.pathname==='/finalize'){
   const status=await coordinator.status();if(!status)throw Error('Missing journal');let opens=0;const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/output':'final'},maxReadBytes:1024,output:{writableMounts:['/output'],stagingPrefix:'final-stage',partBytes:5242880,maxWriteBytes:1024,maxOutputBytes:1048576}}),path='/output/'+id+'-'+Number(pad)+(url.searchParams.get('suffix')??'')+'.raw';
   try{await finalizeMediaCheckpointOutput({bucket:env.MEDIA_BUCKET,status,filesystem:{outputExists:files.outputExists!.bind(files),openRead:files.openRead.bind(files),async openWrite(name,options){opens++;return files.openWrite(name,options);}},path,maxObjectBytes:2048,maxWriteBytes:1024,...(url.searchParams.get('overwrite')==='1'?{overwrite:true}:{})});return Response.json({ok:true,opens,path,stages:(await env.MEDIA_BUCKET.list({prefix:'final-stage/'})).objects.length});}
   catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error),opens,path,stages:(await env.MEDIA_BUCKET.list({prefix:'final-stage/'})).objects.length});}
  }
  if(url.pathname==='/status')return Response.json(await coordinator.status());
  if(url.pathname==='/claim')return Response.json(await coordinator.claim(Number(url.searchParams.get('leaseMs')??2000)));
  if(url.pathname==='/cancel')return Response.json(await coordinator.cancel());
  if(url.pathname==='/commit'){
   const body=await json(request) as {lease:MediaCheckpointLease;descriptor:MediaCheckpointDescriptor};const status=await coordinator.commit(body.lease,body.descriptor);
   return url.searchParams.get('lostAck')==='1'?Response.json({error:'Injected lost commit acknowledgement'},{status:503}):Response.json(status);
  }
  if(url.pathname==='/prepare'){
   const claim=await coordinator.claim(Number(url.searchParams.get('leaseMs')??2000));if(!claim)throw Error('No checkpoint lease');
   const state=createAudioReframeState(3,pad,limits),chunks:Uint8Array[]=[],metadata:{samples:number;pts:string}[]=[];try{
    for(const output of state.push(frame(0,4))){chunks.push(packed(output));metadata.push({samples:output.samples,pts:String(output.pts!.value)});}
    const descriptor=await prepareMediaCheckpoint(env.MEDIA_BUCKET,identity,claim.lease,{revision:claim.status.revision+1,inputPosition:'4',outputPosition:'12',state:serializeAudioReframeCheckpoint(state.checkpoint(),limits),output:concat(chunks),finished:false},2048);return Response.json({lease:claim.lease,descriptor,metadata});
   }finally{state.dispose();}
  }
  if(url.pathname==='/resume'){
   const claim=await coordinator.claim(2000);if(!claim)throw Error('No checkpoint lease');const previous=claim.status.commits.at(-1);if(!previous)throw Error('No committed checkpoint');
   const loaded=await loadMediaCheckpoint(env.MEDIA_BUCKET,previous,2048),checkpoint=deserializeAudioReframeCheckpoint(loaded.state,limits);if(checkpoint.received!==claim.status.inputPosition||BigInt(checkpoint.emitted)*4n!==BigInt(claim.status.outputPosition))throw Error('FIFO state and journal positions disagree');const state=createAudioReframeState(3,pad,limits,checkpoint),chunks:Uint8Array[]=[],metadata:{samples:number;pts:string}[]=[];
   try{
    const inputPosition=Number(claim.status.inputPosition);if(inputPosition!==4)throw Error('Unexpected journal input position');for(const output of state.push(frame(inputPosition,8-inputPosition))){chunks.push(packed(output));metadata.push({samples:output.samples,pts:String(output.pts!.value)});}const tail=state.finish();if(tail){chunks.push(packed(tail));metadata.push({samples:tail.samples,pts:String(tail.pts!.value)});}
    const bytes=concat(chunks),descriptor=await prepareMediaCheckpoint(env.MEDIA_BUCKET,identity,claim.lease,{revision:claim.status.revision+1,inputPosition:'8',outputPosition:String(BigInt(claim.status.outputPosition)+BigInt(bytes.length)),state:serializeAudioReframeCheckpoint(state.checkpoint(),limits),output:bytes,finished:true},2048);return Response.json({status:await coordinator.commit(claim.lease,descriptor),metadata});
   }finally{state.dispose();}
  }
  if(url.pathname==='/load'){
   const status=await coordinator.status();if(!status)throw Error('Missing journal');const chunks:Uint8Array[]=[];for(const descriptor of status.commits){const loaded=await loadMediaCheckpoint(env.MEDIA_BUCKET,descriptor,2048);if(loaded.output)chunks.push(loaded.output);}return new Response(concat(chunks));
  }
  return new Response('Unknown',{status:404});
 }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:422});}
}} satisfies ExportedHandler<MediaCheckpointEnv>;
