import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
import type{AacNativeProbe}from'./mp4-aac-explicit.js';
export function loadMp4AacZero(){
 const root='compat/behavior-specs/mp4-aac-zero/',read=(p:string)=>readFileSync(p),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),manifest=JSON.parse(read(root+'manifest.json').toString()) as {sha256:Record<string,string>};
 for(const[name,digest]of Object.entries(manifest.sha256))if(hash(read(root+name))!==digest)throw Error('Changed zero AAC artifact '+name);
 const provenance=JSON.parse(read(root+'provenance.json').toString()) as {reference:{commit:string};caseCount:number;positiveCopies:number;negativeCopies:number;sources:Record<string,string>};
 if(provenance.reference.commit!==JSON.parse(read('compat/upstream.lock.json').toString()).commit)throw Error('Changed zero AAC reference');for(const[name,digest]of Object.entries(provenance.sources))if(hash(read(name))!==digest)throw Error('Changed zero AAC source '+name);
 const inputs=JSON.parse(read(root+'inputs.json').toString()) as {id:string;sourceId:string;mode:string;scale:number;input:string;sha256:string}[],results=JSON.parse(read(root+'results.json').toString()) as {id:string;input:AacNativeProbe;copyExit:number;copy:AacNativeProbe|null}[];
 if(inputs.length!==60||results.length!==60||provenance.caseCount!==60||provenance.positiveCopies!==48||provenance.negativeCopies!==12||new Set(inputs.map(r=>r.id)).size!==60||new Set(results.map(r=>r.id)).size!==60||results.filter(r=>r.copyExit===0&&r.copy!==null).length!==48||results.filter(r=>r.copyExit!==0&&r.copy===null).length!==12)throw Error('Incomplete zero AAC corpus');
 for(const row of inputs)if(hash(Buffer.from(row.input,'base64'))!==row.sha256||!results.some(r=>r.id===row.id))throw Error('Changed zero AAC input '+row.id);return{inputs,results};
}
export function zeroAacCopyJobs(){const f=loadMp4AacZero();return f.inputs.map(row=>{const result=f.results.find(r=>r.id===row.id)!;return{...row,options:['-map','0:a:0'],nativeExit:result.copyExit,expected:result.copy};});}
