import type {R2Bucket} from '@cloudflare/workers-types';
import type {MediaWorkflowInput,MediaWorkflowNode,MediaWorkflowSpec} from './workflow-types.js';
import {validateMediaWorkflowSpec,hashMediaWorkflowSpec} from './workflow-plan.js';

export type BuildMediaWorkflowInput={readonly path:string;readonly source:{readonly kind:'object';readonly key:string}|{readonly kind:'artifact';readonly nodeId:string;readonly path:string}};
export interface BuildMediaWorkflowNode extends Omit<MediaWorkflowNode,'inputs'|'maxAttempts'|'leaseMs'> {
 readonly inputs:readonly BuildMediaWorkflowInput[];
 readonly maxAttempts?:number;
 readonly leaseMs?:number;
}
export interface BuildMediaWorkflowOptions {
 readonly bucket:Pick<R2Bucket,'head'>;
 readonly workflowId:string;
 readonly sourceGraphHash?:string;
 readonly nodes:readonly BuildMediaWorkflowNode[];
 readonly maxParallel?:number;
 readonly pollIntervalMs?:number;
 readonly maxPolls?:number;
}
function freeze<T>(value:T):T {
 if(value!==null&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))freeze(item);}
 return value;
}
/** Pin each external object once across the graph; downstream inputs will retain
 * the parent's committed artifact generation rather than repinning a mutable key.
 */
export async function buildMediaWorkflowSpec(options:BuildMediaWorkflowOptions):Promise<MediaWorkflowSpec>{
 const head=options.bucket.head.bind(options.bucket);
 // Full graph validation and snapshot happen before the first provider await.
 const snapshot=validateMediaWorkflowSpec({version:1,workflowId:options.workflowId,graphHash:'0'.repeat(64),...(options.sourceGraphHash===undefined?{}:{sourceGraphHash:options.sourceGraphHash}),nodes:options.nodes.map(node=>({...node,maxAttempts:node.maxAttempts??3,leaseMs:node.leaseMs??30000,inputs:node.inputs.map(input=>({path:input.path,source:input.source.kind==='object'?{kind:'object',key:input.source.key,etag:'pending',version:'pending',size:0}:{...input.source}}))})),maxParallel:options.maxParallel??2,pollIntervalMs:options.pollIntervalMs??1000,maxPolls:options.maxPolls??256});
 const keys=[...new Set(snapshot.nodes.flatMap(node=>node.inputs.flatMap(input=>input.source.kind==='object'?[input.source.key]:[])))];
 const pins=new Map<string,{etag:string;version:string;size:number}>();
 for(let index=0;index<keys.length;index+=16)await Promise.all(keys.slice(index,index+16).map(async key=>{
  const object=await head(key);
  if(!object||!Number.isSafeInteger(object.size)||object.size<0||!object.etag||!object.version)throw new Error('Invalid or missing media workflow input: '+key);
  pins.set(key,{etag:object.etag,version:object.version,size:object.size});
 }));
 const nodes=snapshot.nodes.map(node=>({...node,inputs:node.inputs.map((input):MediaWorkflowInput=>input.source.kind==='object'?{path:input.path,source:{kind:'object',key:input.source.key,...pins.get(input.source.key)!}}:input)}));
 const pinned=validateMediaWorkflowSpec({...snapshot,nodes});
 return freeze({...pinned,graphHash:await hashMediaWorkflowSpec(pinned)});
}
