import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
import {loadMediaCheckpoint,mediaCheckpointCoordinatorName,runCheckpointedMediaUnit} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import type {MediaCheckpointComponent,MediaCheckpointJournal,MediaCheckpointStatus} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import {createAudioReframeState,serializeAudioReframeCheckpoint,deserializeAudioReframeCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioReframeState} from '@edge-ffmpeg/avfilter';
export {MediaCheckpointCoordinator} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object';
const limits={maxFrameBytes:1024},unitSamples=5,maxInputSamples=4096,maxMetadataBytes=4096,inputKey='inputs/runner.s16le';
type Frame={samples:number;pts:string};
interface FifoUnitState {readonly fifo:AudioReframeState;frames:Frame[]}
function packed(frame:AudioFrameData){const bytes=new Uint8Array(frame.samples*4);for(let sample=0;sample<frame.samples;sample++)for(let channel=0;channel<2;channel++)bytes.set(frame.planes[channel]!.subarray(sample*2,sample*2+2),(sample*2+channel)*2);return bytes;}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
// State blob: u32le metadata length, bounded JSON of the last unit's emitted frames, FIFO checkpoint.
function encode(state:FifoUnitState):Uint8Array{const meta=new TextEncoder().encode(JSON.stringify(state.frames)),fifo=serializeAudioReframeCheckpoint(state.fifo.checkpoint(),limits);if(meta.length>maxMetadataBytes)throw Error('Fixture metadata bound');const bytes=new Uint8Array(4+meta.length+fifo.length);new DataView(bytes.buffer).setUint32(0,meta.length,true);bytes.set(meta,4);bytes.set(fifo,4+meta.length);return bytes;}
function decode(bytes:Uint8Array):{frames:Frame[];fifo:Uint8Array}{
 if(bytes.length<4)throw Error('Truncated fixture state');const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);if(length>maxMetadataBytes||4+length>bytes.length)throw Error('Invalid fixture state metadata');
 const frames=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.subarray(4,4+length))) as unknown;if(!Array.isArray(frames)||frames.some(frame=>!frame||!Number.isSafeInteger(frame.samples)||typeof frame.pts!=='string'))throw Error('Invalid fixture frame metadata');return {frames:frames as Frame[],fifo:bytes.subarray(4+length)};
}
async function readInput(bucket:R2Bucket,etag:string,start:number,count:number):Promise<AudioFrameData>{
 const object=await bucket.get(inputKey,{range:{offset:start*4,length:count*4},onlyIf:{etagMatches:etag}});if(!object||!('body' in object)||!object.body)throw Error('Pinned input object changed');
 const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length!==count*4)throw Error('Short pinned input range');
 const planes=[new Uint8Array(count*2),new Uint8Array(count*2)];for(let sample=0;sample<count;sample++)for(let channel=0;channel<2;channel++)planes[channel]!.set(bytes.subarray((sample*2+channel)*2,(sample*2+channel)*2+2),sample*2);
 return {sampleRate:8000,channels:2,channelLayout:'stereo',sampleFormat:'s16p',samples:count,planes,pts:{value:123n+BigInt(start),timeBase:{num:1n,den:8000n}}};
}
export default {async fetch(request:Request,env:MediaCheckpointEnv):Promise<Response>{
 const url=new URL(request.url),pad=url.searchParams.get('pad')==='1',etag=url.searchParams.get('etag')??'',fingerprint=url.searchParams.get('fingerprint')??'',mode=url.searchParams.get('mode')??'';
 try{
  const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),value=>value.toString(16).padStart(2,'0')).join('');
  const identity={jobId:'runner-'+Number(pad),workUnitId:'audio',graphHash:await digest(new TextEncoder().encode('asetnsamples=3:'+pad+':unit='+unitSamples)),inputFingerprint:fingerprint,implementationVersion:'reframe-runner-v1'};
  const stub=env.CHECKPOINTS.getByName(await mediaCheckpointCoordinatorName(identity));
  if(url.pathname==='/status'){await stub.initialize(identity);return Response.json(await stub.status());}
  if(url.pathname==='/frames'){
   const status=await stub.status() as MediaCheckpointStatus|null;if(!status)throw Error('Missing journal');const frames:Frame[]=[];
   for(const descriptor of status.commits){const loaded=await loadMediaCheckpoint(env.MEDIA_BUCKET,descriptor,2048);frames.push(...decode(loaded.state).frames);}return Response.json(frames);
  }
  if(url.pathname!=='/run')return new Response('Unknown',{status:404});
  const head=await env.MEDIA_BUCKET.head(inputKey);if(!head||head.etag!==etag||head.customMetadata?.edgeInputSha256!==fingerprint||head.size%4||head.size/4>maxInputSamples)throw Error('Input object does not match the pinned fingerprint');const total=head.size/4;
  // Fault injection wraps the real coordinator stub: `lostAck` drops one commit
  // reply; `crash` commits once and then fails every call like a dead runtime.
  let lostAck=mode==='lostAck',dead=false;const alive=()=>{if(dead)throw Error('Injected runtime loss');};
  const journal:MediaCheckpointJournal={
   async initialize(value){alive();return await stub.initialize(value) as MediaCheckpointStatus;},async claim(leaseMs){alive();return await stub.claim(leaseMs);},
   async heartbeat(lease){alive();return await stub.heartbeat(lease);},async status(){alive();return await stub.status() as MediaCheckpointStatus|null;},
   async commit(lease,descriptor){alive();const status=await stub.commit(lease,descriptor) as MediaCheckpointStatus;if(lostAck){lostAck=false;throw Error('Injected lost commit acknowledgement');}if(mode==='crash'){dead=true;throw Error('Injected runtime loss after commit');}return status;},
  };
  const component:MediaCheckpointComponent<FifoUnitState>={
   create:()=>({fifo:createAudioReframeState(3,pad,limits),frames:[]}),
   restore:bytes=>{const saved=decode(bytes);return {fifo:createAudioReframeState(3,pad,limits,deserializeAudioReframeCheckpoint(saved.fifo,limits)),frames:[]};},
   async process(state,position,signal){
    signal?.throwIfAborted();const start=Number(position.inputPosition),count=Math.min(unitSamples,total-start);if(!Number.isSafeInteger(start)||count<1)throw Error('Unit outside pinned input');
    const chunks:Uint8Array[]=[];state.frames=[];const collect=(frame:AudioFrameData)=>{chunks.push(packed(frame));state.frames.push({samples:frame.samples,pts:String(frame.pts!.value)});};
    for(const frame of state.fifo.push(await readInput(env.MEDIA_BUCKET,etag,start,count)))collect(frame);const finished=start+count===total;if(finished){const tail=state.fifo.finish();if(tail)collect(tail);}
    return {output:chunks.length?concat(chunks):null,inputPosition:String(start+count),finished};
   },
   serialize:encode,
   verify:(state,position)=>{const checkpoint=state.fifo.checkpoint();return checkpoint.received===position.inputPosition&&(BigInt(checkpoint.emitted)*4n).toString()===position.outputPosition;},
   dispose:state=>state.fifo.dispose(),
  };
  const files=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/output':'final'},maxReadBytes:1024,output:{writableMounts:['/output'],stagingPrefix:'final-stage',partBytes:5242880,maxWriteBytes:1024,maxOutputBytes:1048576}});
  const result=await runCheckpointedMediaUnit({bucket:env.MEDIA_BUCKET,journal,identity,component,leaseMs:Number(url.searchParams.get('leaseMs')??500),maxUnits:Number(url.searchParams.get('maxUnits')??1),maxObjectBytes:2048,finalize:{filesystem:files,path:'/output/runner-'+Number(pad)+'.raw',maxWriteBytes:1024}});
  return Response.json({...result,finalized:result.finalized?{...result.finalized,bytes:String(result.finalized.bytes)}:null,conflict:result.conflict?result.conflict.message:null,stages:(await env.MEDIA_BUCKET.list({prefix:'final-stage/'})).objects.length});
 }catch(error){const message=(value:unknown):string=>value instanceof AggregateError?value.message+': '+value.errors.map(message).join('; '):value instanceof Error?value.message:String(value);return Response.json({error:message(error)},{status:500});}
}} satisfies ExportedHandler<MediaCheckpointEnv>;
