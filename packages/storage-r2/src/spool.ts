import type {R2Bucket} from '@cloudflare/workers-types';
export interface R2SpoolStore<T>{append(index:number,value:T,signal?:AbortSignal):Promise<void>;read(index:number,signal?:AbortSignal):Promise<T>;discardBefore(index:number):Promise<void>;close():Promise<void>}
/** Private, ephemeral namespace. Caller serializes mutations and closes after all reads.
 * Codec must bound its own allocations; limits below cover encoded payload only.
 * No cross-isolate recovery or persisted Error identity is claimed. */
export function createR2SpoolStore<T>(bucket:R2Bucket,codec:{encode(value:T):Uint8Array;decode(bytes:Uint8Array):T},limits:{maxRecordBytes:number;maxWrittenBytes:number}):R2SpoolStore<T>{
 const settings={...limits};for(const n of Object.values(settings))if(!Number.isSafeInteger(n)||n<1)throw new Error('Invalid R2 spool bounds');
 const prefix=`edgeffmpeg-spool/${crypto.randomUUID()}/`,owner=crypto.randomUUID();let next=0,attempted=0,discarded=0,written=0,failed=false,closed=false,closing:Promise<void>|undefined;
 const key=(index:number)=>`${prefix}${index}`;
 const active=()=>{if(closed||failed)throw new Error('R2 spool is closed or failed');};
 const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer)),n=>n.toString(16).padStart(2,'0')).join('');
 const remove=async(before:number)=>{while(discarded<before){await bucket.delete(key(discarded));discarded++;}};
 return {
  async append(index,value,signal){active();signal?.throwIfAborted();if(index!==next)throw new Error('Noncontiguous R2 spool append');
   try{const bytes=codec.encode(value).slice();if(bytes.byteLength>settings.maxRecordBytes||bytes.byteLength>settings.maxWrittenBytes-written)throw new Error('R2 spool byte budget exceeded');
    const hash=await digest(bytes);signal?.throwIfAborted();attempted=index+1;
    await bucket.put(key(index),bytes,{sha256:hash,customMetadata:{owner,index:String(index),schema:'1',sha256:hash}});signal?.throwIfAborted();written+=bytes.byteLength;next++;
   }catch(error){failed=true;throw error;}
  },
  async read(index,signal){active();signal?.throwIfAborted();if(!Number.isSafeInteger(index)||index<discarded||index>=next)throw new Error('Invalid R2 spool read');
   const object=await bucket.get(key(index));if(!object){signal?.throwIfAborted();throw new Error('Missing R2 spool record');}
   let primary:unknown,hasPrimary=false;try{signal?.throwIfAborted();if(object.size>settings.maxRecordBytes||object.customMetadata?.owner!==owner||object.customMetadata.index!==String(index)||object.customMetadata.schema!=='1')throw new Error('Invalid R2 spool record');
    const bytes=new Uint8Array(await object.arrayBuffer());signal?.throwIfAborted();if(bytes.byteLength!==object.size||await digest(bytes)!==object.customMetadata.sha256)throw new Error('Corrupt R2 spool record');signal?.throwIfAborted();return codec.decode(bytes);
   }catch(error){hasPrimary=true;primary=error;throw error;}finally{if(!object.bodyUsed)try{await object.body.cancel();}catch(cleanup){if(hasPrimary)throw new AggregateError([primary,cleanup],'R2 spool read and body cleanup failed');throw cleanup;}}
  },
  async discardBefore(index){active();if(!Number.isSafeInteger(index)||index<discarded||index>next)throw new Error('Invalid R2 spool discard');try{await remove(index);}catch(error){failed=true;throw error;}},
  close(){closed=true;return closing??=(async()=>{await remove(attempted);})();}
 };
}
