import type {R2Bucket,R2ObjectBody} from '@cloudflare/workers-types';
import type {ReadHandle,VirtualFileSystem,WriteHandle,WriteOptions} from '@edge-ffmpeg/core';
import type {MediaCheckpointStatus} from './types.js';
import type {MediaCheckpointWorkflowSpec} from './workflow-spec.js';
import type {FinalizeMediaCheckpointOutputOptions} from './output.js';
import {finalizeMediaCheckpointOutput} from './output.js';
import {snapshotMediaCheckpointDescriptor,snapshotMediaCheckpointIdentity} from './state.js';
import {verifyMediaCheckpointWorkflowSpec} from './workflow-spec.js';

/** Pointer to the immutable result manifest of one finished checkpoint workflow. */
export interface MediaCheckpointWorkflowManifest {
 readonly workflowId:string;readonly specHash:string;readonly key:string;
 readonly etag:string;readonly version:string;readonly size:number;readonly sha256:string;
 /** Finalized destination, its byte length (decimal) and the SHA-256 of the bytes finalization published or verified there. */
 readonly path:string;readonly bytes:string;readonly outputSha256:string;
 /** Committed revisions and the committed journal digest. */
 readonly revisions:number;readonly journalSha256:string;
}
/** How the destination of `spec.output.path` is resolved and patched; the same values finalization used. */
export interface MediaCheckpointWorkflowOutputBinding {
 /** Filesystem that resolves `spec.output.path` (for example `createR2FileSystem` staged output). */
 readonly filesystem:VirtualFileSystem;
 readonly patches?:FinalizeMediaCheckpointOutputOptions['patches'];readonly maxPatches?:number;readonly maxPatchBytes?:number;
}
/** Content of a destination that finalization published or verified: byte length (decimal) and SHA-256. */
export interface MediaCheckpointWorkflowDestination {readonly bytes:string;readonly sha256:string}
type Digest=WritableStream<Uint8Array>&{readonly digest:Promise<ArrayBuffer>};
const encoder=new TextEncoder(),maxManifestBytes=65536;
const hexOf=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
const hex=async(bytes:Uint8Array<ArrayBuffer>)=>hexOf(await crypto.subtle.digest('SHA-256',bytes));
// Workers' streaming SHA-256: a destination digest never buffers the destination.
const digester=()=>{const DigestStream=(crypto as unknown as {DigestStream?:new(algorithm:string)=>Digest}).DigestStream;if(typeof DigestStream!=='function')throw TypeError('Checkpoint workflow requires crypto.DigestStream');return DigestStream;};
const digestStream=():Digest=>new (digester())('SHA-256');
/** Throws `TypeError` unless the runtime provides `crypto.DigestStream` (Workers do). */
export function requireMediaCheckpointWorkflowDigest():void{digester();}
/** SHA-256 of the canonical committed descriptors: binds a manifest to one exact finished journal. */
export async function mediaCheckpointJournalDigest(status:MediaCheckpointStatus):Promise<string>{
 if(!status||!Array.isArray(status.commits)||status.commits.length>256)throw Error('Invalid checkpoint journal for digest');
 return hex(new Uint8Array(encoder.encode(JSON.stringify(status.commits.map(snapshotMediaCheckpointDescriptor)))));
}
/** Filesystem view hashing exactly the bytes finalization publishes (writer slices, after a confirmed commit)
 * or verifies (an existing destination, read in order). `digest(existing)` returns the one the result names;
 * an incomplete observation is an error, never a guess. Hashing streams; nothing is buffered.
 */
export function tapMediaCheckpointWorkflowDestination(files:VirtualFileSystem):{readonly files:VirtualFileSystem;digest(existing:boolean):Promise<string>}{
 type Observed={readonly complete:()=>boolean;readonly stream:Digest;readonly writer:WritableStreamDefaultWriter<Uint8Array>};
 let written:Observed|null=null,read:Observed|null=null;
 const view:VirtualFileSystem={
  ...(files.outputExists?{outputExists:(path:string,signal?:AbortSignal,options?:WriteOptions)=>files.outputExists!(path,signal,options)}:{}),
  async openRead(path):Promise<ReadHandle>{
   const handle=await files.openRead(path),stream=digestStream(),writer=stream.getWriter(),size=handle.size;let next=0n;read={complete:()=>next===size,stream,writer};
   return {size,async readAt(offset,length,signal){const bytes=await handle.readAt(offset,length,signal);if(offset!==next||!(bytes instanceof Uint8Array))throw Error('Checkpoint destination was not read in order');await writer.write(bytes);next+=BigInt(bytes.length);return bytes;}};
  },
  async openWrite(path,options):Promise<WriteHandle>{
   const handle=await files.openWrite(path,options),stream=digestStream(),writer=stream.getWriter();let committed=false;written=null;
   return {async write(chunk){await writer.write(chunk);await handle.write(chunk);},async commit(){await handle.commit();committed=true;written={complete:()=>committed,stream,writer};},abort:reason=>handle.abort(reason)};
  },
 };
 return {files:view,async digest(existing){
  const source=existing?read:written;if(!source?.complete())throw Error('Checkpoint destination digest was not observed');
  await source.writer.close();return hexOf(await source.stream.digest);
 }};
}
async function sameBody(object:R2ObjectBody,expected:Uint8Array):Promise<boolean>{
 const reader=object.body.getReader();let offset=0;
 try{for(;;){const part=await reader.read();if(part.done)return offset===expected.length;if(part.value.length>expected.length-offset)return false;for(let index=0;index<part.value.length;index++)if(part.value[index]!==expected[offset+index])return false;offset+=part.value.length;}}
 finally{try{await reader.cancel();}finally{reader.releaseLock();}}
}
function pointer(object:{etag:string;version:string;size:number}):{etag:string;version:string;size:number}{
 if(!object.etag||!object.version||!Number.isSafeInteger(object.size)||object.size<1||object.size>maxManifestBytes)throw Error('Invalid checkpoint workflow manifest object metadata');return {etag:object.etag,version:object.version,size:object.size};
}
function finishedJournal(spec:MediaCheckpointWorkflowSpec,status:MediaCheckpointStatus){
 if(!status||status.phase!=='finished'||status.lease!==null||JSON.stringify(snapshotMediaCheckpointIdentity(status.identity))!==JSON.stringify(spec.identity)||!Number.isInteger(status.revision)||status.revision<1||!Array.isArray(status.commits)||status.commits.length!==status.revision)throw Error('Checkpoint workflow result requires its finished journal');
 const commits=status.commits.map(snapshotMediaCheckpointDescriptor),last=commits.at(-1)!;
 if(!last.finished||last.revision!==status.revision||last.inputPosition!==status.inputPosition||last.outputPosition!==status.outputPosition)throw Error('Checkpoint workflow result journal head disagrees with its terminal commit');
 return commits;
}
/** Stream the existing destination through finalization's no-clobber verification (it never opens a writer)
 * and return its size and SHA-256 when it holds exactly the finished journal's assembled, patched output.
 * A different destination throws `MediaCheckpointOutputConflictError`; a missing one, the adapter's error.
 */
export async function verifyMediaCheckpointWorkflowDestination(bucket:R2Bucket,inputSpec:MediaCheckpointWorkflowSpec,status:MediaCheckpointStatus,binding:MediaCheckpointWorkflowOutputBinding,signal?:AbortSignal):Promise<MediaCheckpointWorkflowDestination>{
 const spec=await verifyMediaCheckpointWorkflowSpec(inputSpec),files=binding?.filesystem;finishedJournal(spec,status);
 if(!files||typeof files.openRead!=='function'||binding.patches!==undefined&&typeof binding.patches!=='function')throw TypeError('Invalid checkpoint workflow output binding');
 const tap=tapMediaCheckpointWorkflowDestination({outputExists:async()=>true,openRead:path=>files.openRead(path),openWrite:async()=>{throw TypeError('Checkpoint destination verification never writes');}});
 const verified=await finalizeMediaCheckpointOutput({bucket,status,filesystem:tap.files,path:spec.output.path,overwrite:false,maxObjectBytes:spec.policy.maxObjectBytes,maxWriteBytes:spec.output.maxWriteBytes,maxReadBytes:spec.output.maxReadBytes,
  ...(binding.patches===undefined?{}:{patches:binding.patches}),...(binding.maxPatches===undefined?{}:{maxPatches:binding.maxPatches}),...(binding.maxPatchBytes===undefined?{}:{maxPatchBytes:binding.maxPatchBytes}),...(signal?{signal}:{})});
 if(verified.existing!==true)throw Error('Checkpoint destination verification did not verify an existing destination');
 return {bytes:verified.bytes.toString(),sha256:await tap.digest(true)};
}
/** Conditional immutable publication at `checkpoint-workflows/<workflowId>/<specHash>.json` of a finished
 * journal whose destination content the caller already established (the Workflow passes what its unit step's
 * finalization published or verified). The body is a pure function of the spec, the finished journal and that
 * content (never of whether the destination was published now or verified as existing), so any replay or lost
 * write acknowledgement verifies the exact stored bytes and metadata.
 */
export async function publishVerifiedMediaCheckpointWorkflowResult(bucket:R2Bucket,inputSpec:MediaCheckpointWorkflowSpec,status:MediaCheckpointStatus,destination:MediaCheckpointWorkflowDestination):Promise<MediaCheckpointWorkflowManifest>{
 const spec=await verifyMediaCheckpointWorkflowSpec(inputSpec),commits=finishedJournal(spec,status);
 if(!destination||destination.bytes!==status.outputPosition||typeof destination.sha256!=='string'||!/^[a-f0-9]{64}$/.test(destination.sha256))throw Error('Checkpoint workflow result requires the verified destination of its finished journal');
 const journalSha256=await mediaCheckpointJournalDigest(status),outputChunks=commits.filter(commit=>commit.output!==null).length,outputSha256=destination.sha256;
 const body={version:1,workflowId:spec.workflowId,specHash:spec.specHash,identity:spec.identity,output:{path:spec.output.path,bytes:status.outputPosition,sha256:outputSha256,revisions:status.revision,outputChunks},journal:{revision:status.revision,inputPosition:status.inputPosition,outputPosition:status.outputPosition,sha256:journalSha256}};
 const bytes=new Uint8Array(encoder.encode(JSON.stringify(body)));if(bytes.length>maxManifestBytes)throw RangeError('Checkpoint workflow manifest byte limit exceeded');
 const sha256=await hex(bytes),key=`checkpoint-workflows/${spec.workflowId}/${spec.specHash}.json`;
 const metadata={edgeCheckpointWorkflowId:spec.workflowId,edgeCheckpointWorkflowSpecHash:spec.specHash,edgeCheckpointWorkflowResultSha256:sha256};
 const manifest=(object:{etag:string;version:string;size:number}):MediaCheckpointWorkflowManifest=>({workflowId:spec.workflowId,specHash:spec.specHash,key,...pointer(object),sha256,path:spec.output.path,bytes:status.outputPosition,outputSha256,revisions:status.revision,journalSha256});
 let writeError:unknown;
 try{const object=await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},customMetadata:metadata,httpMetadata:{contentType:'application/json'}});if(object)return manifest(object);}
 catch(error){writeError=error;}
 const object=await bucket.get(key);
 if(!object){if(writeError!==undefined)throw writeError;throw Error('Checkpoint workflow result publication could not be confirmed');}
 if(object.size!==bytes.length||Object.entries(metadata).some(([name,value])=>object.customMetadata?.[name]!==value)){await object.body.cancel();throw Error('Immutable checkpoint workflow result conflict');}
 if(!await sameBody(object,bytes))throw Error('Immutable checkpoint workflow result byte conflict');
 return manifest(object);
}
/** Publish the manifest of a finished journal (the coordinator's `status()`) only after verifying, through
 * `binding`, that the destination holds exactly its assembled output (`verifyMediaCheckpointWorkflowDestination`).
 * Replays verify the stored manifest like the Workflow's own publication.
 */
export async function publishMediaCheckpointWorkflowResult(bucket:R2Bucket,spec:MediaCheckpointWorkflowSpec,status:MediaCheckpointStatus,binding:MediaCheckpointWorkflowOutputBinding,signal?:AbortSignal):Promise<MediaCheckpointWorkflowManifest>{
 return publishVerifiedMediaCheckpointWorkflowResult(bucket,spec,status,await verifyMediaCheckpointWorkflowDestination(bucket,spec,status,binding,signal));
}
