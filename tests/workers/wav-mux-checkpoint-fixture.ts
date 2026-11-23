import {createR2FileSystem,R2CommitUncertainError,recoverPublishedR2Output} from '@edge-ffmpeg/storage-r2';
import {finalizeMediaCheckpointOutput,loadMediaCheckpointOutput,mediaCheckpointCoordinatorName,runCheckpointedMediaUnit,MediaCheckpointOutputConflictError} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import type {MediaCheckpointComponent,MediaCheckpointJournal,MediaCheckpointOutputPatch,MediaCheckpointStatus} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import {createAudioReframeState,serializeAudioReframeCheckpoint,deserializeAudioReframeCheckpoint} from '@edge-ffmpeg/avfilter';
import type {AudioReframeState} from '@edge-ffmpeg/avfilter';
import {createWavMuxState,deserializeWavMuxState,serializeWavMuxState,wavMuxPatches} from '@edge-ffmpeg/containers';
import type {WavMuxState,WavOutputFormat} from '@edge-ffmpeg/containers';
import type {AudioFrameData,MediaPacket} from '@edge-ffmpeg/avutil';
export {MediaCheckpointCoordinator} from '@edge-ffmpeg/runtime-cloudflare/checkpoints/durable-object';
// Each case mirrors one Native command: aformat=<planar>,asetnsamples=n=3:p=<pad> into a seekable .wav.
const cases={
 's16-pad':{sampleFormat:'s16p',width:2,channels:2,layout:'stereo',codec:'pcm_s16le',mask:3,pad:true,bitexact:false},
 'u8-odd':{sampleFormat:'u8p',width:1,channels:1,layout:'mono',codec:'pcm_u8',mask:4,pad:false,bitexact:true},
 'f32-fact':{sampleFormat:'fltp',width:4,channels:2,layout:'stereo',codec:'pcm_f32le',mask:3,pad:true,bitexact:false},
} as const;
type Case=(typeof cases)[keyof typeof cases];
const limits={maxFrameBytes:1024},unitSamples=5,maxInputSamples=4096,sampleRate=8000;
interface WavUnitState {readonly fifo:AudioReframeState;readonly mux:WavMuxState}
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
// State blob: u32le FIFO checkpoint length, FIFO checkpoint, canonical WAV mux snapshot.
function encode(state:WavUnitState):Uint8Array{const fifo=serializeAudioReframeCheckpoint(state.fifo.checkpoint(),limits),wav=serializeWavMuxState(state.mux.snapshot()),bytes=new Uint8Array(4+fifo.length+wav.length);new DataView(bytes.buffer).setUint32(0,fifo.length,true);bytes.set(fifo,4);bytes.set(wav,4+fifo.length);return bytes;}
function decode(bytes:Uint8Array):{fifo:Uint8Array;wav:Uint8Array}{if(bytes.length<4)throw Error('Truncated fixture state');const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);if(4+length>bytes.length)throw Error('Invalid fixture state');return {fifo:bytes.subarray(4,4+length),wav:bytes.subarray(4+length)};}
function packet(frame:AudioFrameData,spec:Case):MediaPacket{
 const block=spec.channels*spec.width,data=new Uint8Array(frame.samples*block);
 for(let sample=0;sample<frame.samples;sample++)for(let channel=0;channel<spec.channels;channel++)data.set(frame.planes[channel]!.subarray(sample*spec.width,(sample+1)*spec.width),sample*block+channel*spec.width);
 return {streamIndex:0,data,pts:frame.pts!.value,dts:frame.pts!.value,duration:BigInt(frame.samples),timeBase:frame.pts!.timeBase,flags:1};
}
async function readInput(bucket:R2Bucket,key:string,etag:string,spec:Case,start:number,count:number):Promise<AudioFrameData>{
 const block=spec.channels*spec.width,object=await bucket.get(key,{range:{offset:start*block,length:count*block},onlyIf:{etagMatches:etag}});if(!object||!('body' in object)||!object.body)throw Error('Pinned input object changed');
 const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length!==count*block)throw Error('Short pinned input range');
 const planes=Array.from({length:spec.channels},()=>new Uint8Array(count*spec.width));for(let sample=0;sample<count;sample++)for(let channel=0;channel<spec.channels;channel++)planes[channel]!.set(bytes.subarray(sample*block+channel*spec.width,sample*block+(channel+1)*spec.width),sample*spec.width);
 return {sampleRate,channels:spec.channels,channelLayout:spec.layout,sampleFormat:spec.sampleFormat,samples:count,planes,pts:{value:BigInt(start),timeBase:{num:1n,den:BigInt(sampleRate)}}};
}
export default {async fetch(request:Request,env:MediaCheckpointEnv):Promise<Response>{
 const url=new URL(request.url),name=url.searchParams.get('case')??'',etag=url.searchParams.get('etag')??'',fingerprint=url.searchParams.get('fingerprint')??'',mode=url.searchParams.get('mode')??'';
 const message=(value:unknown):string=>value instanceof AggregateError?value.message+': '+value.errors.map(message).join('; '):value instanceof Error?value.message:String(value);
 try{
  if(!Object.hasOwn(cases,name))throw Error('Unknown fixture case');const spec=cases[name as keyof typeof cases],inputKey='inputs/'+name+'.raw',format:WavOutputFormat={codec:spec.codec,channels:spec.channels,sampleRate,channelMask:spec.mask},muxOptions={metadataProfile:'ffmpeg-9.0.2' as const,bitexact:spec.bitexact};
  const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),value=>value.toString(16).padStart(2,'0')).join('');
  const identity={jobId:'wav-'+name,workUnitId:'audio',graphHash:await digest(new TextEncoder().encode(JSON.stringify(spec)+':unit='+unitSamples)),inputFingerprint:fingerprint,implementationVersion:'wav-mux-v1'};
  const stub=env.CHECKPOINTS.getByName(await mediaCheckpointCoordinatorName(identity));
  if(url.pathname==='/status'){await stub.initialize(identity);return Response.json(await stub.status());}
  if(url.pathname==='/raw'){
   // Unpatched committed stream: what a consumer sees before native's trailer rewrites.
   const status=await stub.status() as MediaCheckpointStatus|null;if(!status)throw Error('Missing journal');const chunks:Uint8Array[]=[];
   for(const descriptor of status.commits){const bytes=await loadMediaCheckpointOutput(env.MEDIA_BUCKET,descriptor,4096);if(bytes)chunks.push(bytes);}return new Response(concat(chunks));
  }
  if(url.pathname==='/run'){
   const head=await env.MEDIA_BUCKET.head(inputKey),block=spec.channels*spec.width;if(!head||head.etag!==etag||head.customMetadata?.edgeInputSha256!==fingerprint||head.size%block||head.size/block>maxInputSamples)throw Error('Input object does not match the pinned fingerprint');const total=head.size/block;
   const journal:MediaCheckpointJournal={
    async initialize(value){return await stub.initialize(value) as MediaCheckpointStatus;},async claim(leaseMs){return await stub.claim(leaseMs);},
    async heartbeat(lease){return await stub.heartbeat(lease);},async status(){return await stub.status() as MediaCheckpointStatus|null;},async commit(lease,descriptor){return await stub.commit(lease,descriptor) as MediaCheckpointStatus;},
   };
   const component:MediaCheckpointComponent<WavUnitState>={
    create:()=>({fifo:createAudioReframeState(3,spec.pad,limits),mux:createWavMuxState(format,muxOptions)}),
    restore:bytes=>{const saved=decode(bytes);return {fifo:createAudioReframeState(3,spec.pad,limits,deserializeAudioReframeCheckpoint(saved.fifo,limits)),mux:createWavMuxState(format,muxOptions,deserializeWavMuxState(saved.wav))};},
    async process(state,position,signal){
     signal?.throwIfAborted();const start=Number(position.inputPosition),count=Math.min(unitSamples,total-start);if(!Number.isSafeInteger(start)||count<1)throw Error('Unit outside pinned input');
     const chunks:Uint8Array[]=[];if(state.mux.bytes===0n)chunks.push(state.mux.start());
     for(const frame of state.fifo.push(await readInput(env.MEDIA_BUCKET,inputKey,etag,spec,start,count)))chunks.push(state.mux.write(packet(frame,spec)));
     const finished=start+count===total;if(finished){const tail=state.fifo.finish();if(tail)chunks.push(state.mux.write(packet(tail,spec)));const trailer=state.mux.finish();if(trailer.bytes.length)chunks.push(trailer.bytes);}
     return {output:chunks.length?concat(chunks):null,inputPosition:String(start+count),finished};
    },
    serialize:encode,
    verify:(state,position)=>{const fifo=state.fifo.checkpoint();return fifo.received===position.inputPosition&&state.mux.bytes.toString()===position.outputPosition&&state.mux.samples.toString()===fifo.emitted&&state.mux.finished===fifo.finished;},
    dispose:state=>state.fifo.dispose(),
   };
   const result=await runCheckpointedMediaUnit({bucket:env.MEDIA_BUCKET,journal,identity,component,leaseMs:Number(url.searchParams.get('leaseMs')??500),maxUnits:Number(url.searchParams.get('maxUnits')??1),maxObjectBytes:4096});
   return Response.json({outcome:result.outcome,units:result.units,status:result.status});
  }
  // Multipart uploads are not listed objects: a live upload still accepts a part. Each probed live upload is aborted.
  const live=async(uploads:readonly {key:string;uploadId:string}[])=>{let count=0;for(const {key,uploadId} of uploads){const upload=env.MEDIA_BUCKET.resumeMultipartUpload(key,uploadId);try{await upload.uploadPart(1,new Uint8Array(1));}catch{continue;}count++;await upload.abort();}return count;};
  if(url.pathname==='/probe-control'){
   // Positive and negative controls for `live` on this R2 emulation.
   const open=await env.MEDIA_BUCKET.createMultipartUpload('final-stage/control-open'),aborted=await env.MEDIA_BUCKET.createMultipartUpload('final-stage/control-aborted');await aborted.abort();
   return Response.json({open:await live([open]),aborted:await live([aborted]),reprobed:await live([open])});
  }
  if(url.pathname!=='/finalize')return new Response('Unknown',{status:404});
  const status=await stub.status() as MediaCheckpointStatus|null;if(!status)throw Error('Missing journal');
  const path='/output/'+(url.searchParams.get('target')??name)+'.wav',destination='final/'+path.slice('/output/'.length),competitor=url.searchParams.get('competitor');let opens=0,injected=0;
  // Fault injection wraps the real binding: `appear` publishes a competing object just before the pre-commit
  // existence recheck, `race` just before the conditional destination put; `vanish` lets a competitor win the
  // put and then deletes it; `integrity` hides the completed staging object from the adapter's check;
  // `uncertain` lets the put land and then loses its acknowledgement.
  const real=env.MEDIA_BUCKET,uploads:{key:string;uploadId:string}[]=[],copy=async()=>{const object=await real.get(competitor??'');if(!object)throw Error('Missing competitor');await real.put(destination,await object.arrayBuffer());};
  let heads=0;const bucket={
   async head(key:string){if(key===destination&&mode==='appear'&&heads++===1)await copy();return real.head(key);},delete:(keys:string|string[])=>real.delete(keys),list:(options?:R2ListOptions)=>real.list(options),
   async get(key:string,options?:R2GetOptions){if(mode==='integrity'&&key.startsWith('final-stage/')&&!injected++)return null;return real.get(key,options);},
   async createMultipartUpload(key:string,options?:R2MultipartOptions){const upload=await real.createMultipartUpload(key,options);uploads.push({key,uploadId:upload.uploadId});return upload;},
   async put(key:string,value:Parameters<R2Bucket['put']>[1],options?:R2PutOptions){
    if(key===destination&&options?.onlyIf&&mode==='race'&&!injected++)await copy();
    if(key===destination&&options?.onlyIf&&mode==='vanish'&&!injected++){await copy();const lost=await real.put(key,value,options);await real.delete(destination);return lost;}
    if(key===destination&&mode==='uncertain'&&!injected++){await real.put(key,value,options);throw Error('Injected lost publication acknowledgement');}
    return real.put(key,value,options);
   },
  } as unknown as R2Bucket;
  const files=createR2FileSystem({bucket,mounts:{'/output':'final'},maxReadBytes:16,output:{writableMounts:['/output'],stagingPrefix:'final-stage',partBytes:5242880,maxWriteBytes:64,maxOutputBytes:1048576}});
  const stages=async()=>(await real.list({prefix:'final-stage/'})).objects.length;
  const patches=async(terminal:{state:Uint8Array;bytes:bigint}):Promise<readonly MediaCheckpointOutputPatch[]>=>{
   const snapshot=deserializeWavMuxState(decode(terminal.state).wav);if(BigInt(snapshot.bytes)!==terminal.bytes)throw Error('WAV mux snapshot disagrees with committed output bytes');
   if(mode==='range')return [{offset:terminal.bytes-2n,bytes:new Uint8Array(4)}];if(mode==='overlap')return [{offset:4n,bytes:new Uint8Array(4)},{offset:6n,bytes:new Uint8Array(4)}];
   return wavMuxPatches(snapshot);
  };
  try{
   const result=await finalizeMediaCheckpointOutput({bucket:env.MEDIA_BUCKET,status,filesystem:{outputExists:files.outputExists!.bind(files),openRead:files.openRead.bind(files),async openWrite(target,options){opens++;return files.openWrite(target,options);}},path,maxObjectBytes:4096,maxWriteBytes:64,maxReadBytes:16,patches,...(url.searchParams.get('overwrite')==='1'?{overwrite:true}:{})});
   return Response.json({ok:true,existing:result.existing===true,bytes:String(result.bytes),outputChunks:result.outputChunks,opens,stages:await stages(),uploads:uploads.length,live:await live(uploads)});
  }catch(error){
   const conflict=error instanceof MediaCheckpointOutputConflictError?{expected:{bytes:String(error.expected.bytes),sha256:error.expected.sha256},actual:{bytes:String(error.actual.bytes),sha256:error.actual.sha256}}:null;
   const report={ok:false,error:message(error),range:error instanceof RangeError,conflict,opens,stages:await stages(),uploads:uploads.length,live:await live(uploads)};
   if(error instanceof R2CommitUncertainError)return Response.json({...report,uncertain:true,recovered:await recoverPublishedR2Output(real,error),afterRecovery:await stages()});
   return Response.json(report);
  }
 }catch(error){return Response.json({error:message(error)},{status:500});}
}} satisfies ExportedHandler<MediaCheckpointEnv>;
