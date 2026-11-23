import type {R2Bucket} from '@cloudflare/workers-types';
import type {ExecutionCheckpointIdentity,VirtualFileSystem} from '@edge-ffmpeg/core';
import {R2CommitUncertainError} from '@edge-ffmpeg/storage-r2';
import {snapshotMediaCheckpointIdentity,snapshotMediaCheckpointDescriptor,mediaCheckpointCoordinatorName} from './state.js';
import type {MediaCheckpointStatus,MediaCheckpointDescriptor} from './types.js';
import {loadMediaCheckpoint,loadMediaCheckpointOutput} from './artifacts.js';
/** Bytes that replace `[offset, offset+bytes.length)` of the assembled output while it streams. */
export interface MediaCheckpointOutputPatch {readonly offset:bigint;readonly bytes:Uint8Array}
/** Terminal committed descriptor and its state bytes, loaded through `loadMediaCheckpoint` pins. */
export interface MediaCheckpointTerminalState {readonly descriptor:MediaCheckpointDescriptor;readonly state:Uint8Array;readonly bytes:bigint}
export interface FinalizeMediaCheckpointOutputOptions {
 readonly bucket:R2Bucket;readonly status:MediaCheckpointStatus;
 readonly filesystem:VirtualFileSystem;readonly path:string;
 readonly maxObjectBytes?:number;readonly maxWriteBytes?:number;
 /** Upper slice bound for reading an existing destination during no-clobber verification (default
  * maxWriteBytes); a RangeError from the adapter's readAt halves the slice instead of failing at once. */
 readonly maxReadBytes?:number;
 readonly signal?:AbortSignal;readonly overwrite?:boolean;
 /** Derive container header rewrites from the verified terminal state only. Patches are copied and
  * validated (count, bytes, range, overlap) before any destination is probed, read or opened. */
 readonly patches?:(terminal:MediaCheckpointTerminalState,signal?:AbortSignal)=>readonly MediaCheckpointOutputPatch[]|Promise<readonly MediaCheckpointOutputPatch[]>;
 readonly maxPatches?:number;readonly maxPatchBytes?:number;
}
export interface FinalizedMediaCheckpointOutput {
 readonly bytes:bigint;readonly revisions:number;readonly outputChunks:number;
 /** A no-clobber destination already held exactly the assembled bytes; no writer or staging was created for it. */
 readonly existing?:true;
}
/** A no-clobber destination exists with a different size or SHA-256 than the assembled journal output. */
export class MediaCheckpointOutputConflictError extends Error {
 constructor(readonly path:string,readonly expected:{readonly bytes:bigint;readonly sha256:string|null},readonly actual:{readonly bytes:bigint;readonly sha256:string|null}){super('Checkpoint output destination exists with different content');}
}
const sameIdentity=(a:ExecutionCheckpointIdentity,b:ExecutionCheckpointIdentity)=>JSON.stringify(a)===JSON.stringify(b);
const published=(error:unknown)=>typeof error==='object'&&error!==null&&'published' in error&&error.published===true;
function snapshot(value:MediaCheckpointStatus):{identity:ExecutionCheckpointIdentity;commits:MediaCheckpointDescriptor[];bytes:bigint}{
 if(!value||value.phase!=='finished'||value.lease!==null||!Number.isInteger(value.revision)||value.revision<1||value.revision>256||!Array.isArray(value.commits)||value.commits.length!==value.revision)throw Error('Checkpoint output requires a complete finished journal');
 const identity=snapshotMediaCheckpointIdentity(value.identity),commits=value.commits.map(snapshotMediaCheckpointDescriptor);let input=0n,output=0n;
 for(const [index,commit]of commits.entries()){
  const nextInput=BigInt(commit.inputPosition),nextOutput=BigInt(commit.outputPosition),delta=nextOutput-output;
  if(commit.revision!==index+1||!sameIdentity(identity,commit.identity)||commit.finished!==(index===commits.length-1)||nextInput<input||nextOutput<output||!commit.finished&&nextInput===input&&nextOutput===output||delta===0n&&commit.output!==null||delta>0n&&(commit.output===null||BigInt(commit.output.size)!==delta))throw Error('Inconsistent checkpoint output journal');
  input=nextInput;output=nextOutput;
 }
 if(value.inputPosition!==input.toString()||value.outputPosition!==output.toString())throw Error('Checkpoint output head disagrees with journal');
 return {identity,commits,bytes:output};
}
const rounds=Uint32Array.of(0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2);
/** Incremental FIPS 180-4 SHA-256: WebCrypto digests are one-shot, and verification must not buffer an object. */
function sha256(){
 const h=Uint32Array.of(0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19),w=new Uint32Array(64),block=new Uint8Array(64);let filled=0,length=0;
 const rotr=(x:number,n:number)=>x>>>n|x<<(32-n);
 function compress(data:Uint8Array,at:number):void{
  for(let i=0;i<16;i++)w[i]=data[at+i*4]!<<24|data[at+i*4+1]!<<16|data[at+i*4+2]!<<8|data[at+i*4+3]!;
  for(let i=16;i<64;i++){const x=w[i-15]!,y=w[i-2]!;w[i]=(rotr(x,7)^rotr(x,18)^x>>>3)+w[i-16]!+(rotr(y,17)^rotr(y,19)^y>>>10)+w[i-7]!;}
  let a=h[0]!,b=h[1]!,c=h[2]!,d=h[3]!,e=h[4]!,f=h[5]!,g=h[6]!,k=h[7]!;
  for(let i=0;i<64;i++){const t1=k+(rotr(e,6)^rotr(e,11)^rotr(e,25))+(e&f^~e&g)+rounds[i]!+w[i]!|0,t2=(rotr(a,2)^rotr(a,13)^rotr(a,22))+(a&b^a&c^b&c)|0;k=g;g=f;f=e;e=d+t1|0;d=c;c=b;b=a;a=t1+t2|0;}
  h[0]=h[0]!+a;h[1]=h[1]!+b;h[2]=h[2]!+c;h[3]=h[3]!+d;h[4]=h[4]!+e;h[5]=h[5]!+f;h[6]=h[6]!+g;h[7]=h[7]!+k;
 }
 return {
  update(data:Uint8Array):void{
   let at=0;length+=data.length;
   if(filled){at=Math.min(64-filled,data.length);block.set(data.subarray(0,at),filled);filled+=at;if(filled<64)return;compress(block,0);filled=0;}
   for(;at+64<=data.length;at+=64)compress(data,at);block.set(data.subarray(at),0);filled=data.length-at;
  },
  digest():string{
   block[filled++]=0x80;if(filled>56){block.fill(0,filled);compress(block,0);filled=0;}
   block.fill(0,filled,56);new DataView(block.buffer).setBigUint64(56,BigInt(length)*8n);compress(block,0);
   return Array.from(h,word=>word.toString(16).padStart(8,'0')).join('');
  }
 };
}
/** Assemble the committed output byte stream of a finished journal through an
 * atomic VFS writer, optionally rewriting bounded header ranges derived from the
 * verified terminal state. This is byte assembly, not container remuxing.
 *
 * No-clobber (`overwrite !== true`) replay: an existing destination is streamed
 * and its size and SHA-256 compared with the assembled (patched) output; equal
 * content returns `existing: true`, different content throws
 * `MediaCheckpointOutputConflictError`. Neither opens a writer. A destination
 * that appears before commit, or wins the conditional publish, aborts staging
 * and then receives the same verification. Any failure before commit aborts the
 * writer. A commit failure aborts it too, unless it is R2 uncertain publication
 * or published-but-cleanup-failed, which are rethrown with staging retained;
 * adapters own the rest (an aborted writer in an uncertain state keeps staging).
 */
export async function finalizeMediaCheckpointOutput(options:FinalizeMediaCheckpointOutputOptions):Promise<FinalizedMediaCheckpointOutput>{
 const {bucket,filesystem,path,signal,overwrite,patches:derive}=options,maxObjectBytes=options.maxObjectBytes??8388608,maxWriteBytes=options.maxWriteBytes??65536,maxReadBytes=options.maxReadBytes??maxWriteBytes,maxPatches=options.maxPatches??16,maxPatchBytes=options.maxPatchBytes??4096;
 if(typeof path!=='string'||!path.startsWith('/')||/[\\\0]/.test(path)||path.slice(1).split('/').some(part=>!part||part==='.'||part==='..')||overwrite!==undefined&&typeof overwrite!=='boolean')throw TypeError('Invalid checkpoint output destination');
 if(derive!==undefined&&typeof derive!=='function')throw TypeError('Invalid checkpoint output patch source');
 if(!Number.isSafeInteger(maxObjectBytes)||maxObjectBytes<1||maxObjectBytes>67108864||!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1||maxWriteBytes>maxObjectBytes||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||maxReadBytes>maxObjectBytes)throw RangeError('Invalid checkpoint assembly byte limits');
 if(!Number.isSafeInteger(maxPatches)||maxPatches<1||maxPatches>256||!Number.isSafeInteger(maxPatchBytes)||maxPatchBytes<1||maxPatchBytes>65536)throw RangeError('Invalid checkpoint output patch limits');
 signal?.throwIfAborted();const captured=snapshot(options.status);
 // Preflight every object before opening a destination or reading R2.
 for(const commit of captured.commits)if(commit.output&&commit.output.size>maxObjectBytes)throw RangeError('Checkpoint output chunk exceeds byte limit');
 const namespaceName=await mediaCheckpointCoordinatorName(captured.identity),root='checkpoints/'+namespaceName+'/';
 for(const commit of captured.commits){
  const suffix=`/revision-${commit.revision}/state.bin`,key=commit.state.key;
  if(!key.startsWith(root)||!key.endsWith(suffix))throw Error('Checkpoint state belongs to another journal');
  const owner=key.slice(root.length,-suffix.length).split('/');if(owner.length!==2||!/^[1-9][0-9]*$/.test(owner[0]!)||!Number.isSafeInteger(Number(owner[0]))||!/^[-_A-Za-z0-9]{1,128}$/.test(owner[1]!))throw Error('Invalid checkpoint attempt ownership');
  if(commit.output&&commit.output.key!==key.slice(0,-'state.bin'.length)+'output.bin')throw Error('Checkpoint output belongs to another attempt');
 }
 const edits:{offset:bigint;bytes:Uint8Array}[]=[];
 if(derive){
  // The journal stays the single source of truth: patches see only pinned, digest-verified terminal state.
  signal?.throwIfAborted();const descriptor=captured.commits.at(-1)!,loaded=await loadMediaCheckpoint(bucket,descriptor,maxObjectBytes);signal?.throwIfAborted();
  const listed=await derive({descriptor:snapshotMediaCheckpointDescriptor(descriptor),state:loaded.state,bytes:captured.bytes},signal);signal?.throwIfAborted();
  if(!Array.isArray(listed))throw TypeError('Invalid checkpoint output patch list');const count=listed.length;if(count>maxPatches)throw RangeError('Checkpoint output patch count exceeds limit');
  let total=0;
  for(let index=0;index<count;index++){
   const patch=listed[index] as MediaCheckpointOutputPatch|undefined,offset=patch?.offset,bytes=patch?.bytes;
   if(typeof offset!=='bigint'||!(bytes instanceof Uint8Array)||!bytes.length)throw TypeError('Invalid checkpoint output patch');
   total+=bytes.length;if(total>maxPatchBytes)throw RangeError('Checkpoint output patches exceed byte limit');edits.push({offset,bytes:bytes.slice()});
  }
  edits.sort((a,b)=>a.offset<b.offset?-1:a.offset>b.offset?1:0);let end=0n;
  for(const edit of edits){const next=edit.offset+BigInt(edit.bytes.length);if(edit.offset<0n||next>captured.bytes)throw RangeError('Checkpoint output patch is outside the assembled output');if(edit.offset<end)throw RangeError('Checkpoint output patches overlap');end=next;}
 }
 const apply=(bytes:Uint8Array,start:bigint)=>{
  const end=start+BigInt(bytes.length);
  for(const edit of edits){const stop=edit.offset+BigInt(edit.bytes.length),from=edit.offset>start?edit.offset:start,to=stop<end?stop:end;if(from<to)bytes.set(edit.bytes.subarray(Number(from-edit.offset),Number(to-edit.offset)),Number(from-start));}
 };
 // Committed chunks in revision order, one object at a time; the next object is read only after every slice is consumed.
 const assemble=async(sink:(slice:Uint8Array)=>Promise<void>|void):Promise<number>=>{
  let position=0n,chunks=0;
  for(const descriptor of captured.commits){
   signal?.throwIfAborted();if(!descriptor.output)continue;
   const bytes=await loadMediaCheckpointOutput(bucket,descriptor,maxObjectBytes);signal?.throwIfAborted();if(!bytes)throw Error('Missing checkpoint output bytes');
   apply(bytes,position);position+=BigInt(bytes.length);
   for(let offset=0;offset<bytes.length;offset+=maxWriteBytes){signal?.throwIfAborted();await sink(bytes.subarray(offset,Math.min(bytes.length,offset+maxWriteBytes)));}
   chunks++;
  }
  return chunks;
 };
 const verify=async():Promise<FinalizedMediaCheckpointOutput>=>{
  signal?.throwIfAborted();const existing=await filesystem.openRead(path),size=existing.size;signal?.throwIfAborted();
  if(size!==captured.bytes)throw new MediaCheckpointOutputConflictError(path,{bytes:captured.bytes,sha256:null},{bytes:size,sha256:null});
  const expected=sha256(),outputChunks=await assemble(slice=>expected.update(slice)),expectedDigest=expected.digest(),actual=sha256();let step=maxReadBytes;
  for(let offset=0n;offset<size;){
   signal?.throwIfAborted();const length=size-offset<BigInt(step)?Number(size-offset):step;let bytes:Uint8Array;
   // The VFS does not expose its own read bound: a RangeError halves the slice (at most log2(maxReadBytes) times).
   try{bytes=await existing.readAt(offset,length,signal);}catch(error){signal?.throwIfAborted();if(!(error instanceof RangeError)||length<2)throw error;step=length>>>1;continue;}
   signal?.throwIfAborted();if(!(bytes instanceof Uint8Array)||bytes.length!==length)throw Error('Existing checkpoint output read was short or invalid');actual.update(bytes);offset+=BigInt(length);
  }
  const actualDigest=actual.digest();if(actualDigest!==expectedDigest)throw new MediaCheckpointOutputConflictError(path,{bytes:captured.bytes,sha256:expectedDigest},{bytes:size,sha256:actualDigest});
  return {bytes:captured.bytes,revisions:captured.commits.length,outputChunks,existing:true};
 };
 const policy={overwrite:overwrite===true},present=async()=>overwrite!==true&&filesystem.outputExists!==undefined&&await filesystem.outputExists(path,signal,policy);
 // Replay after publication: verify the existing destination without opening a writer or staging.
 signal?.throwIfAborted();if(await present())return verify();
 signal?.throwIfAborted();const writer=await filesystem.openWrite(path,overwrite===undefined?undefined:{overwrite});let commitAttempted=false,discarded=false;
 const discard=async(reason:unknown)=>{discarded=true;try{await writer.abort(reason);}catch(cleanup){throw new AggregateError([reason,cleanup],'Checkpoint output failed and staging cleanup could not be confirmed');}};
 try{
  const outputChunks=await assemble(slice=>writer.write(slice));
  // Recheck before the conditional publish; a destination that appears now is a definite pre-commit loss.
  signal?.throwIfAborted();
  if(await present())await discard(Error('Checkpoint output destination appeared before publication'));
  else{
   signal?.throwIfAborted();commitAttempted=true;
   try{await writer.commit();return {bytes:captured.bytes,revisions:captured.commits.length,outputChunks};}
   catch(error){
    // Uncertain publication keeps staging for adapter recovery; a published result is the adapter's to report.
    if(error instanceof R2CommitUncertainError||published(error))throw error;
    // Any other failure is definite for this writer: discard staging first (abort touches staging only, and an
    // adapter left uncertain keeps what its recovery needs), then a destination that exists now is a lost
    // no-clobber race and receives verification.
    await discard(error);let raced:boolean;
    try{raced=await present();}catch(inspection){throw new AggregateError([error,inspection],'Checkpoint output commit failed and destination inspection failed');}
    if(!raced)throw error;
   }
  }
  return await verify();
 }catch(error){
  if(!commitAttempted&&!discarded){try{await writer.abort(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Checkpoint output failed and staging cleanup could not be confirmed');}}
  throw error;
 }
}
