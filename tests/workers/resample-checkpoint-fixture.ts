import {serializeExecutionCheckpoint,deserializeExecutionCheckpoint} from '@edge-ffmpeg/core';
import {createAudioResampleState,serializeAudioResampleCheckpoint,deserializeAudioResampleCheckpoint,resampleAudio} from '@edge-ffmpeg/swresample';
import type {AudioResampleOptions} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
/** Same order as resample-checkpoint.test.ts, which runs aresample=<outputRate>:tsf=s16p on the pinned reference. */
const resampleCheckpointCases=[{inputRate:44100,outputRate:48000},{inputRate:48000,outputRate:8000},{inputRate:44100,outputRate:48001},{inputRate:8000,outputRate:44100}] as const;
const partition=[37,1,64,64,64,64,64,42],samples=partition.reduce((sum,count)=>sum+count,0),limits={maxFrameBytes:256,maxStateBytes:131072,sampleFormat:'s16'} as const;
function value(index:number,channel:number){return (index*3137+channel*7919)%65536-32768;}
function frame(rate:number,start:number,count:number):AudioFrameData{return {sampleRate:rate,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:count,planes:[0,1].map(channel=>{const bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,value(start+i,channel),true);return bytes;}),pts:{value:BigInt(start),timeBase:{num:1n,den:BigInt(rate)}}};}
const starts=partition.map((_,index)=>partition.slice(0,index).reduce((sum,count)=>sum+count,0));
function packed(frame:AudioFrameData){const bytes=new Uint8Array(frame.samples*4);for(let sample=0;sample<frame.samples;sample++)for(let channel=0;channel<2;channel++)bytes.set(frame.planes[channel]!.subarray(sample*2,sample*2+2),(sample*2+channel)*2);return bytes;}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
export default {async fetch(request:Request,env:Pick<MediaWorkflowEnv,'MEDIA_BUCKET'>):Promise<Response>{
 const url=new URL(request.url),index=Number(url.searchParams.get('case')),split=Number(url.searchParams.get('split')),selected=resampleCheckpointCases[index],prefix='c'+index+'s'+split+'/';
 try{
  if(!selected||!Number.isSafeInteger(split)||split<0||split>256)throw Error('Unknown resampling case');
  const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),value=>value.toString(16).padStart(2,'0')).join('');
  const identity={jobId:'resample-'+index+'-'+split,workUnitId:'audio',graphHash:await digest(new TextEncoder().encode('aresample='+selected.outputRate+':tsf=s16p')),inputFingerprint:await digest(packed(frame(selected.inputRate,0,samples))),implementationVersion:'resample-v1'};
  const metadata:{samples:number;pts:string}[]=[],chunks:Uint8Array[]=[];const collect=(output:AudioFrameData)=>{if(output.sampleFormat!=='s16p'||output.sampleRate!==selected.outputRate||output.pts?.timeBase.den!==BigInt(selected.outputRate))throw Error('Resampled metadata mismatch');metadata.push({samples:output.samples,pts:String(output.pts.value)});chunks.push(packed(output));};
  if(url.pathname==='/full'){
   async function* source(){for(const [position,start]of starts.entries())yield frame(selected!.inputRate,start,partition[position]!);}
   for await(const output of resampleAudio(source(),selected.outputRate,limits))collect(output);const bytes=concat(chunks);await env.MEDIA_BUCKET.put(prefix+'full.pcm',bytes);return Response.json({metadata,bytes:bytes.length});
  }
  if(url.pathname==='/first'){
   // Input frames are steps 0-7; each later step is one bounded EOF tail frame.
   const state=createAudioResampleState(selected.outputRate,limits);try{
    for(let step=0;step<split&&!state.finished;step++){if(step<partition.length)for(const output of state.push(frame(selected.inputRate,starts[step]!,partition[step]!)))collect(output);else for(const output of state.finish(1))collect(output);}
    const checkpoint=state.checkpoint(),bytes=serializeAudioResampleCheckpoint(checkpoint,limits),filterStateRef='states/resample-'+await digest(bytes)+'.bin',committed=concat(chunks);
    await env.MEDIA_BUCKET.put(filterStateRef,bytes);await env.MEDIA_BUCKET.put(prefix+'committed.pcm',committed);await env.MEDIA_BUCKET.put(prefix+'committed.json',JSON.stringify(metadata));
    await env.MEDIA_BUCKET.put(prefix+'envelope.bin',serializeExecutionCheckpoint({...identity,version:1,lastCommittedPosition:BigInt(committed.length),filterStateRef}));
    return Response.json({metadata,checkpointBytes:bytes.length,filterStateRef,received:checkpoint.received,historyBytes:checkpoint.history.length,pendingBytes:checkpoint.pending.length,eof:checkpoint.eof,finished:checkpoint.finished});
   }finally{state.dispose();}
  }
  if(url.pathname==='/resume'){
   const envelope=await env.MEDIA_BUCKET.get(prefix+'envelope.bin');if(!envelope||envelope.size>16384)throw Error('Missing/bounded checkpoint envelope');
   const expected=url.searchParams.get('mode')==='identity-mismatch'?{...identity,implementationVersion:'other-version'}:identity,accepted=deserializeExecutionCheckpoint(new Uint8Array(await envelope.arrayBuffer()),expected);
   const committed=await env.MEDIA_BUCKET.get(prefix+'committed.pcm'),previous=await env.MEDIA_BUCKET.get(prefix+'committed.json');if(!committed||!previous||BigInt(committed.size)!==accepted.lastCommittedPosition)throw Error('Committed output position mismatch');
   const reference=accepted.filterStateRef?.match(/^states\/resample-([a-f0-9]{64})\.bin$/);if(!reference)throw Error('Unexpected state reference');const stored=await env.MEDIA_BUCKET.get(accepted.filterStateRef!);if(!stored||stored.size>4096)throw Error('Checkpoint fixture bound');
   const serialized=new Uint8Array(await stored.arrayBuffer());if(await digest(serialized)!==reference[1])throw Error('Checkpoint state digest mismatch');
   const controller=new AbortController();if(url.searchParams.get('mode')==='cancelled')controller.abort(Error('Injected resume cancellation'));
   const options:AudioResampleOptions={...limits,maxStateBytes:url.searchParams.get('mode')==='budget'?1024:limits.maxStateBytes,signal:controller.signal};
   // Coefficients are rebuilt from the bound plan here; only history, counters and pending output come from R2.
   const state=createAudioResampleState(selected.outputRate,options,deserializeAudioResampleCheckpoint(serialized,options));try{
    const saved=state.checkpoint(),received=Number(saved.received),next=received===samples?partition.length:starts.indexOf(received);if(next<0)throw Error('Checkpoint is not at an input frame boundary');
    if(!saved.eof)for(let position=next;position<partition.length;position++)for(const output of state.push(frame(selected.inputRate,starts[position]!,partition[position]!)))collect(output);
    for(const output of state.finish())collect(output);
    const bytes=concat([new Uint8Array(await committed.arrayBuffer()),...chunks]),allMetadata=[...await previous.json<{samples:number;pts:string}[]>(),...metadata];await env.MEDIA_BUCKET.put(prefix+'resumed.pcm',bytes);return Response.json({metadata:allMetadata,bytes:bytes.length});
   }finally{state.dispose();}
  }
  return new Response('Unknown',{status:404});
 }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:422});}
}} satisfies ExportedHandler<Pick<MediaWorkflowEnv,'MEDIA_BUCKET'>>;
