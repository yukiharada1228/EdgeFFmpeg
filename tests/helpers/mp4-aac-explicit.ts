import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
export interface AacNativeProbe {
 packets:{stream_index:number;pts:string|null;dts:string|null;duration:string;pos?:string;flags:number;size:number;sha256:string;skipSamples:{skipSamples:number;discardPadding:number}|null}[];
 streams:{codec:string;id:number;default:number;timeBase:string;sampleRate:number;channels:number;start:string|null;duration:string|null;count:string;extradata:string}[];
 formatStartUs:string|null;
}
export function loadMp4AacExplicit(){
 const root='compat/behavior-specs/mp4-aac-explicit/',read=(p:string)=>readFileSync(p),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),manifest=JSON.parse(read(root+'manifest.json').toString()) as {sha256:Record<string,string>};
 for(const [name,digest] of Object.entries(manifest.sha256))if(hash(read(root+name))!==digest)throw Error('Changed explicit AAC artifact '+name);
 const provenance=JSON.parse(read(root+'provenance.json').toString()) as {reference:{commit:string};caseCount:number;sources:Record<string,string>;validation:{cases:number;failures:unknown[]}};
 if(provenance.reference.commit!==JSON.parse(read('compat/upstream.lock.json').toString()).commit||provenance.validation.cases!==1533||provenance.validation.failures.length)throw Error('Changed explicit AAC reference or probe validation');
 for(const [name,digest] of Object.entries(provenance.sources))if(hash(read(name))!==digest)throw Error('Changed explicit AAC source '+name);
 const inputs=JSON.parse(read(root+'inputs.json').toString()) as {id:string;family:string;input:string;sha256:string}[],results=JSON.parse(read(root+'results.json').toString()) as {id:string;input:AacNativeProbe;copy:AacNativeProbe}[];
 if(inputs.length!==384||results.length!==384||provenance.caseCount!==384||new Set(inputs.map(r=>r.id)).size!==384||new Set(results.map(r=>r.id)).size!==384)throw Error('Incomplete explicit AAC corpus');
 for(const row of inputs)if(hash(Buffer.from(row.input,'base64'))!==row.sha256||!results.some(r=>r.id===row.id))throw Error('Changed explicit AAC input '+row.id);
 return{inputs,results};
}
export function buildExplicitAacProbe(){execFileSync(process.execPath,['tools/differential-runner/mp4-aac-explicit/build-native.mjs'],{timeout:120000,maxBuffer:8388608});return '.build/aac-native-probe/probe';}
export function probeExplicitAac(binary:string,path:string,copy=false):AacNativeProbe {
 const p=spawnSync(binary,[path],{encoding:'utf8',timeout:15000,maxBuffer:8388608});if(p.status!==0)throw Error('Native AAC probe failed '+p.status+' '+p.stderr);
 const result=JSON.parse(p.stdout) as AacNativeProbe;if(copy)result.packets=result.packets.map(p=>{const copy={...p};delete copy.pos;return copy;});return result;
}
export function explicitAacCopyJobs(){const f=loadMp4AacExplicit();return f.inputs.map(row=>({...row,options:['-map','0:a:0'],expected:f.results.find(r=>r.id===row.id)!.copy}));}
