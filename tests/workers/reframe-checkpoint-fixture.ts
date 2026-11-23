import {serializeExecutionCheckpoint,deserializeExecutionCheckpoint} from '@edge-ffmpeg/core';
import {createAudioReframeState,serializeAudioReframeCheckpoint,deserializeAudioReframeCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const left=[1,-2,300,-400,32767,-32768,7,-8],right=[-9,10,-1100,1200,-1300,1400,-1500,1600],limits={maxFrameBytes:1024};
function frame(start:number,count:number):AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:count,planes:[left,right].map(values=>{const bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,values[start+i]!,true);return bytes;}),pts:{value:123n+BigInt(start),timeBase:{num:1n,den:8000n}}};}
function packed(frame:AudioFrameData){const bytes=new Uint8Array(frame.samples*4);for(let sample=0;sample<frame.samples;sample++)for(let channel=0;channel<2;channel++)bytes.set(frame.planes[channel]!.subarray(sample*2,sample*2+2),(sample*2+channel)*2);return bytes;}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
export default {async fetch(request:Request,env:Pick<MediaWorkflowEnv,'MEDIA_BUCKET'>):Promise<Response>{
 const url=new URL(request.url),pad=url.searchParams.get('pad')==='1',prefix=pad?'p1/':'p0/';
 try{
  const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),value=>value.toString(16).padStart(2,'0')).join('');
  const identity={jobId:'reframe-'+prefix[1],workUnitId:'audio',graphHash:await digest(new TextEncoder().encode('asetnsamples=3:'+pad)),inputFingerprint:await digest(packed(frame(0,8))),implementationVersion:'reframe-v1'};
  const metadata:{samples:number;pts:string}[]=[],chunks:Uint8Array[]=[];const collect=(output:AudioFrameData)=>{metadata.push({samples:output.samples,pts:String(output.pts!.value)});chunks.push(packed(output));};
  if(url.pathname==='/first'){
   const state=createAudioReframeState(3,pad,limits);try{for(const output of state.push(frame(0,4)))collect(output);const checkpoint=state.checkpoint(),bytes=serializeAudioReframeCheckpoint(checkpoint,limits);const filterStateRef='states/reframe-'+await digest(bytes)+'.bin';await env.MEDIA_BUCKET.put(filterStateRef,bytes);await env.MEDIA_BUCKET.put(prefix+'committed.pcm',concat(chunks));await env.MEDIA_BUCKET.put(prefix+'committed.json',JSON.stringify(metadata));await env.MEDIA_BUCKET.put(prefix+'envelope.bin',serializeExecutionCheckpoint({...identity,version:1,lastCommittedPosition:BigInt(concat(chunks).length),filterStateRef}));return Response.json({metadata,checkpointBytes:bytes.length,filterStateRef});}finally{state.dispose();}
  }
  if(url.pathname==='/resume'||url.pathname==='/full'){
   let stored:R2ObjectBody|null=null,serialized:Uint8Array<ArrayBuffer>|undefined;
   if(url.pathname==='/resume'){
    const envelope=await env.MEDIA_BUCKET.get(prefix+'envelope.bin');if(!envelope||envelope.size>16384)throw Error('Missing/bounded checkpoint envelope');
    const expected=url.searchParams.get('mode')==='identity-mismatch'?{...identity,implementationVersion:'other-version'}:identity;
    const accepted=deserializeExecutionCheckpoint(new Uint8Array(await envelope.arrayBuffer()),expected);
    const committed=await env.MEDIA_BUCKET.head(prefix+'committed.pcm');if(!committed||BigInt(committed.size)!==accepted.lastCommittedPosition)throw Error('Committed output position mismatch');
    const reference=accepted.filterStateRef?.match(/^states\/reframe-([a-f0-9]{64})\.bin$/);if(!reference)throw Error('Unexpected state reference');stored=await env.MEDIA_BUCKET.get(accepted.filterStateRef!);if(!stored||stored.size>2048)throw Error('Checkpoint fixture bound');serialized=new Uint8Array(await stored.arrayBuffer());if(await digest(serialized)!==reference[1])throw Error('Checkpoint state digest mismatch');
   }
   const checkpoint=serialized?deserializeAudioReframeCheckpoint(serialized,limits):undefined;
   const controller=new AbortController();if(url.searchParams.get('mode')==='cancelled')controller.abort(Error('Injected resume cancellation'));
   const options={maxFrameBytes:url.searchParams.get('mode')==='budget'?8:1024,signal:controller.signal};
   const state=createAudioReframeState(3,pad,options,checkpoint);try{
    for(const [start,count]of (stored?[[4,2],[6,2]]:[[0,4],[4,2],[6,2]]))for(const output of state.push(frame(start!,count!)))collect(output);
    const final=state.finish();if(final)collect(final);
    const committed=stored?await env.MEDIA_BUCKET.get(prefix+'committed.pcm'):null,previous=stored?await env.MEDIA_BUCKET.get(prefix+'committed.json'):null;
    const bytes=concat([...(committed?[new Uint8Array(await committed.arrayBuffer())]:[]),...chunks]),allMetadata=[...(previous?await previous.json<{samples:number;pts:string}[]>():[]),...metadata];await env.MEDIA_BUCKET.put(prefix+(stored?'resumed':'full')+'.pcm',bytes);return Response.json({metadata:allMetadata,bytes:bytes.length});
   }finally{state.dispose();}
  }
  return new Response('Unknown',{status:404});
 }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:422});}
}} satisfies ExportedHandler<Pick<MediaWorkflowEnv,'MEDIA_BUCKET'>>;
