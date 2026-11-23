import type {R2Bucket} from '@cloudflare/workers-types';
import type {ResourceBudget} from '@edge-ffmpeg/core';
import type {MediaJobInput,MediaJobSpec} from './types.js';

export interface BuildMediaJobOptions {
 readonly bucket:Pick<R2Bucket,'head'>;
 readonly jobId:string;
 readonly args:readonly string[];
 readonly inputs:readonly {readonly path:string;readonly key:string}[];
 readonly outputs:readonly {readonly path:string}[];
 readonly budget:Readonly<ResourceBudget>;
 /** Must change when the executor, backend, codec artifact or arithmetic profile changes. */
 readonly implementationVersion:string;
 readonly maxAttempts?:number;
 readonly leaseMs?:number;
}
const encoder=new TextEncoder();
function path(value:string):boolean{return typeof value==='string'&&value.startsWith('/')&&value.length<=2048&&!/[\\\0]/.test(value)&&value.slice(1).split('/').every(p=>p!==''&&p!=='.'&&p!=='..');}
function key(value:string):boolean{return typeof value==='string'&&value.length>0&&value.length<=2048&&!value.startsWith('/')&&!/[\\\0]/.test(value)&&value.split('/').every(p=>p!==''&&p!=='.'&&p!=='..');}
async function hash(value:unknown):Promise<string>{const bytes=encoder.encode(JSON.stringify(value));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');}
/** Pin object generations before enqueueing. This hashes a single whole-command
 * WorkUnit descriptor, not a claim of partitioned codec/filter graph support.
 */
export async function buildMediaJobSpec(options:BuildMediaJobOptions):Promise<MediaJobSpec>{
 const jobId=options.jobId,implementationVersion=options.implementationVersion;
 const args=[...options.args],inputs=options.inputs.map(value=>({...value})),outputs=options.outputs.map(value=>({...value})),budget={...options.budget};
 const maxAttempts=options.maxAttempts??3,leaseMs=options.leaseMs??30000,head=options.bucket.head.bind(options.bucket);
 if(typeof jobId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(jobId))throw new TypeError('Invalid media job ID');
 if(typeof implementationVersion!=='string'||implementationVersion.length<1||implementationVersion.length>256)throw new TypeError('Invalid media job implementation version');
 if(args.length<1||args.length>1024||args.some(arg=>typeof arg!=='string'||arg.length>4096||arg.includes('\0'))||args.reduce((n,arg)=>n+encoder.encode(arg).length,0)>65536)throw new TypeError('Invalid bounded media job arguments');
 if(inputs.length<1||inputs.length>16||outputs.length<1||outputs.length>16||inputs.some(value=>!path(value.path)||!key(value.key))||outputs.some(value=>!path(value.path))||new Set([...inputs,...outputs].map(v=>v.path)).size!==inputs.length+outputs.length)throw new TypeError('Invalid or overlapping media job paths');
 if(Object.values(budget).length!==4||Object.values(budget).some(value=>!Number.isSafeInteger(value)||value<1)||budget.maxBufferBytes>budget.maxResidentBytes)throw new RangeError('Invalid media job resource budget');
 if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>100||!Number.isInteger(leaseMs)||leaseMs<10||leaseMs>300000)throw new RangeError('Invalid media job retry or lease policy');
 const pinned:MediaJobInput[]=await Promise.all(inputs.map(async input=>{
  const object=await head(input.key);
  if(!object)throw new Error('Media job input does not exist: '+input.key);
  if(!Number.isSafeInteger(object.size)||object.size<0||!object.etag||!object.version)throw new Error('Invalid media job input metadata');
  return Object.freeze({path:input.path,key:input.key,etag:object.etag,version:object.version,size:object.size});
 }));
 const inputFingerprint=await hash(pinned),graphHash=await hash({version:1,workUnits:[{id:'command',args,inputs:inputs.map(v=>v.path),outputs:outputs.map(v=>v.path)}],budget,implementationVersion});
 return Object.freeze({version:1,jobId,workUnitId:'command',graphHash,inputFingerprint,implementationVersion,args:Object.freeze(args),inputs:Object.freeze(pinned),outputs:Object.freeze(outputs.map(v=>Object.freeze(v))),budget:Object.freeze(budget),maxAttempts,leaseMs});
}
