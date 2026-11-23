import {serializeExecutionCheckpoint,deserializeExecutionCheckpoint} from '@edge-ffmpeg/core';
import {padAudio,createAudioPadState,serializeAudioPadCheckpoint,deserializeAudioPadCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioPadOptions} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
const left=[1,-2,300,-400,32767,-32768,7,-8],right=[-9,10,-1100,1200,-1300,1400,-1500,1600],limits={maxFrameBytes:1024},input=[[0,3],[3,3],[6,2]] as const;
/** Native filter text and equivalent library options; pad-checkpoint.test.ts runs the same ordered filters against the pinned reference. */
const padCheckpointCases:readonly {readonly filter:string;readonly options:Omit<AudioPadOptions,'maxFrameBytes'|'signal'>}[]=[
 {filter:'pad_len=5:packet_size=2',options:{padSamples:5n,packetSamples:2}},{filter:'whole_len=13:packet_size=3',options:{wholeSamples:13n,packetSamples:3}},
 {filter:'pad_dur=625us:packet_size=4',options:{padDurationMicros:625n,packetSamples:4}},{filter:'whole_dur=0.002',options:{wholeDurationMicros:2000n}},{filter:'whole_len=4:packet_size=2',options:{wholeSamples:4n,packetSamples:2}}
];
function frame(start:number,count:number):AudioFrameData{return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:count,planes:[left,right].map(values=>{const bytes=new Uint8Array(count*2),view=new DataView(bytes.buffer);for(let i=0;i<count;i++)view.setInt16(i*2,values[start+i]!,true);return bytes;}),pts:{value:123n+BigInt(start),timeBase:{num:1n,den:8000n}}};}
function packed(frame:AudioFrameData){const bytes=new Uint8Array(frame.samples*4);for(let sample=0;sample<frame.samples;sample++)for(let channel=0;channel<2;channel++)bytes.set(frame.planes[channel]!.subarray(sample*2,sample*2+2),(sample*2+channel)*2);return bytes;}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
export default {async fetch(request:Request,env:Pick<MediaWorkflowEnv,'MEDIA_BUCKET'>):Promise<Response>{
 const url=new URL(request.url),index=Number(url.searchParams.get('case')),split=Number(url.searchParams.get('split')),selected=padCheckpointCases[index],prefix='c'+index+'s'+split+'/';
 try{
  if(!selected||!Number.isSafeInteger(split)||split<0||split>64)throw Error('Unknown padding case');
  const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),value=>value.toString(16).padStart(2,'0')).join('');
  const identity={jobId:'apad-'+index+'-'+split,workUnitId:'audio',graphHash:await digest(new TextEncoder().encode('apad='+selected.filter)),inputFingerprint:await digest(packed(frame(0,8))),implementationVersion:'apad-v1'};
  const metadata:{samples:number;pts:string}[]=[],chunks:Uint8Array[]=[];const collect=(output:AudioFrameData)=>{metadata.push({samples:output.samples,pts:String(output.pts!.value)});chunks.push(packed(output));};
  if(url.pathname==='/full'){
   async function* source(){for(const [start,count]of input)yield frame(start,count);}
   for await(const output of padAudio(source(),{...selected.options,...limits}))collect(output);const bytes=concat(chunks);await env.MEDIA_BUCKET.put(prefix+'full.pcm',bytes);return Response.json({metadata,bytes:bytes.length});
  }
  if(url.pathname==='/first'){
   // Input frames are steps 0-2; each later step is one bounded silence packet.
   const state=createAudioPadState({...selected.options,...limits});try{
    for(let step=0;step<split&&!state.finished;step++){if(step<input.length)collect(state.push(frame(input[step]![0],input[step]![1])));else for(const output of state.finish(1))collect(output);}
    const bytes=serializeAudioPadCheckpoint(state.checkpoint(),limits),filterStateRef='states/apad-'+await digest(bytes)+'.bin',committed=concat(chunks);
    await env.MEDIA_BUCKET.put(filterStateRef,bytes);await env.MEDIA_BUCKET.put(prefix+'committed.pcm',committed);await env.MEDIA_BUCKET.put(prefix+'committed.json',JSON.stringify(metadata));
    await env.MEDIA_BUCKET.put(prefix+'envelope.bin',serializeExecutionCheckpoint({...identity,version:1,lastCommittedPosition:BigInt(committed.length),filterStateRef}));return Response.json({metadata,checkpointBytes:bytes.length,filterStateRef});
   }finally{state.dispose();}
  }
  if(url.pathname==='/resume'){
   const envelope=await env.MEDIA_BUCKET.get(prefix+'envelope.bin');if(!envelope||envelope.size>16384)throw Error('Missing/bounded checkpoint envelope');
   const expected=url.searchParams.get('mode')==='identity-mismatch'?{...identity,implementationVersion:'other-version'}:identity,accepted=deserializeExecutionCheckpoint(new Uint8Array(await envelope.arrayBuffer()),expected);
   const committed=await env.MEDIA_BUCKET.get(prefix+'committed.pcm'),previous=await env.MEDIA_BUCKET.get(prefix+'committed.json');if(!committed||!previous||BigInt(committed.size)!==accepted.lastCommittedPosition)throw Error('Committed output position mismatch');
   const reference=accepted.filterStateRef?.match(/^states\/apad-([a-f0-9]{64})\.bin$/);if(!reference)throw Error('Unexpected state reference');const stored=await env.MEDIA_BUCKET.get(accepted.filterStateRef!);if(!stored||stored.size>2048)throw Error('Checkpoint fixture bound');
   const serialized=new Uint8Array(await stored.arrayBuffer());if(await digest(serialized)!==reference[1])throw Error('Checkpoint state digest mismatch');
   const controller=new AbortController();if(url.searchParams.get('mode')==='cancelled')controller.abort(Error('Injected resume cancellation'));
   const options={...selected.options,maxFrameBytes:url.searchParams.get('mode')==='budget'?4:limits.maxFrameBytes,signal:controller.signal};
   const state=createAudioPadState(options,deserializeAudioPadCheckpoint(serialized,options));try{
    const first=BigInt(state.checkpoint().received),consumed=input.findIndex(([start])=>BigInt(start)>=first);
    for(const [start,count]of consumed<0?[]:input.slice(consumed))collect(state.push(frame(start,count)));for(const output of state.finish())collect(output);
    const bytes=concat([new Uint8Array(await committed.arrayBuffer()),...chunks]),allMetadata=[...await previous.json<{samples:number;pts:string}[]>(),...metadata];await env.MEDIA_BUCKET.put(prefix+'resumed.pcm',bytes);return Response.json({metadata:allMetadata,bytes:bytes.length});
   }finally{state.dispose();}
  }
  return new Response('Unknown',{status:404});
 }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:422});}
}} satisfies ExportedHandler<Pick<MediaWorkflowEnv,'MEDIA_BUCKET'>>;
