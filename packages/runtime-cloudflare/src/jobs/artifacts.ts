import type {R2Bucket} from '@cloudflare/workers-types';
import type {VirtualFileSystem,WriteHandle} from '@edge-ffmpeg/core';
import {createR2FileSystem,InputChangedError} from '@edge-ffmpeg/storage-r2';
import type {MediaJobArtifact,MediaJobInput,MediaJobSpec} from './types.js';

export interface MediaJobArtifactOptions {
 readonly bucket:R2Bucket;readonly spec:MediaJobSpec;readonly prefix:string;
 readonly maxReadBytes:number;readonly maxWriteBytes:number;readonly maxOutputBytes:number;
 readonly signal:AbortSignal;readonly fence:()=>Promise<void>;
}
function matches(object:{etag:string;version:string;size:number}|null,pin:MediaJobInput):boolean{return object!==null&&object.etag===pin.etag&&object.version===pin.version&&object.size===pin.size;}

/** Isolated attempt keys are immutable. Only the coordinator's success pointer
 * publishes them as a job result; this adapter never writes a shared output key.
 */
export function createMediaJobArtifacts(options:MediaJobArtifactOptions):{filesystem:VirtualFileSystem;validateInputs:()=>Promise<void>;artifacts:()=>Promise<readonly MediaJobArtifact[]>;close:()=>Promise<void>} {
 const {bucket,signal,fence}=options,pins=new Map(options.spec.inputs.map(input=>[input.path,Object.freeze({...input})]));
 const outputs=new Map(options.spec.outputs.map((output,index)=>[output.path,`${options.prefix}output-${index}`]));
 const outputFs=createR2FileSystem({bucket,mounts:{'/attempt':options.prefix.replace(/\/$/,'')},maxReadBytes:options.maxReadBytes,output:{writableMounts:['/attempt'],stagingPrefix:`media-job-staging/${crypto.randomUUID()}`,partBytes:5242880,maxWriteBytes:options.maxWriteBytes,maxOutputBytes:options.maxOutputBytes}});
 const writers=new Set<WriteHandle>(),committed=new Set<string>(),opened=new Set<string>();
 const destination=(path:string)=>{const key=outputs.get(path);if(!key)throw Error('Undeclared media job output');return '/attempt/'+key.slice(options.prefix.length);};
 const filesystem:VirtualFileSystem={
  async openRead(path){signal.throwIfAborted();const pin=pins.get(path);if(!pin)throw Error('Undeclared media job input');
   if(!matches(await bucket.head(pin.key),pin))throw new InputChangedError('Submitted media input generation changed');signal.throwIfAborted();
   return {size:BigInt(pin.size),async readAt(offset,length,readSignal){signal.throwIfAborted();readSignal?.throwIfAborted();
    if(offset<0n||!Number.isSafeInteger(length)||length<0||length>options.maxReadBytes)throw RangeError('Invalid media job read range');
    if(offset>=BigInt(pin.size)||length===0)return new Uint8Array();
    const count=Math.min(length,pin.size-Number(offset)),object=await bucket.get(pin.key,{range:{offset:Number(offset),length:count},onlyIf:{etagMatches:pin.etag}});
    if(!object||!('body' in object))throw new InputChangedError('Submitted media input changed while reading');
    if(!matches(object,pin)){await object.body.cancel();throw new InputChangedError('Submitted media input generation changed while reading');}
    if(signal.aborted||readSignal?.aborted){await object.body.cancel();signal.throwIfAborted();readSignal?.throwIfAborted();}
    const bytes=new Uint8Array(count),reader=object.body.getReader();let used=0;
    try{for(;;){signal.throwIfAborted();readSignal?.throwIfAborted();const item=await reader.read();if(item.done)break;if(item.value.length>count-used)throw Error('Invalid media job ranged body size');bytes.set(item.value,used);used+=item.value.length;}}
    finally{try{await reader.cancel();}finally{reader.releaseLock();}}
    signal.throwIfAborted();readSignal?.throwIfAborted();if(used!==count)throw Error('Invalid media job ranged body size');return bytes;
   }};
  },
  async outputExists(path){signal.throwIfAborted();await fence();return outputFs.outputExists!(destination(path),signal);},
  async openWrite(path){signal.throwIfAborted();await fence();if(opened.has(path))throw Error('Media job output opened twice');opened.add(path);
   const writer=await outputFs.openWrite(destination(path),{overwrite:false});writers.add(writer);
   return {async write(bytes){signal.throwIfAborted();await writer.write(bytes);signal.throwIfAborted();},async commit(){signal.throwIfAborted();await fence();await writer.commit();committed.add(path);writers.delete(writer);signal.throwIfAborted();},async abort(reason){try{await writer.abort(reason);}finally{writers.delete(writer);}}};
  }
 };
 return {filesystem,async validateInputs(){for(const pin of pins.values()){signal.throwIfAborted();if(!matches(await bucket.head(pin.key),pin))throw new InputChangedError('Submitted media input generation changed');signal.throwIfAborted();}},async artifacts(){const artifacts:MediaJobArtifact[]=[];
  for(const [path,key]of outputs){if(!committed.has(path))throw Error('Media job output was not committed');const object=await bucket.head(key);if(!object||!Number.isSafeInteger(object.size)||object.size<0||object.size>options.maxOutputBytes)throw Error('Invalid media job artifact');artifacts.push({path,key,etag:object.etag,version:object.version,size:object.size});}
  return Object.freeze(artifacts.map(artifact=>Object.freeze(artifact)));
 },async close(){const results=await Promise.allSettled([...writers].map(writer=>writer.abort(Error('Media job attempt ended'))));writers.clear();const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Media job artifact cleanup failed');}};
}
