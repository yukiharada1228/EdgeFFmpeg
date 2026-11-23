import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
export interface DirectoryCase {
 id:string;group:'single'|'graph'|'termination'|'automatic';profile?:string;bitexact?:boolean;
 argv:string[];directoryPaths:string[];regularInputs:{path:string;input:string}[];outputPaths:string[];mask:number;populated:boolean;exitCode:number;
 outputs:({bytes:number;sha256:string;base64:string}|null)[];stderr:string;
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function nodeInputDirectoryCases():DirectoryCase[]{
 const root='compat/behavior-specs/node-input-directory/',manifest=JSON.parse(readFileSync(root+'manifest.json','utf8')) as {sha256:Record<string,string>};
 for(const[n,digest]of Object.entries(manifest.sha256))if(hash(readFileSync(root+n))!==digest)throw Error('Directory fixture changed: '+n);
 const provenance=JSON.parse(readFileSync(root+'provenance.json','utf8')) as {sources:Record<string,string>;reference:{commit:string;artifacts:Record<string,string>};caseCount:number};
 for(const[p,digest]of Object.entries(provenance.sources))if(hash(readFileSync(p))!==digest)throw Error('Directory source changed: '+p);
 if(provenance.reference.commit!==JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit)throw Error('Directory reference changed');
 for(const n of ['ffmpeg','ffprobe'])if(hash(readFileSync('.build/reference/'+n))!==provenance.reference.artifacts[n])throw Error('Directory Native artifact changed');
 const rows=JSON.parse(readFileSync(root+'results.json','utf8')) as DirectoryCase[];
 if(rows.length!==1932||provenance.caseCount!==1932||new Set(rows.map(r=>r.id)).size!==1932)throw Error('Incomplete directory corpus');
 for(const[group,count]of [['single',1360],['graph',360],['termination',200],['automatic',12]] as const)if(rows.filter(r=>r.group===group).length!==count)throw Error('Incomplete directory group');
 for(const[status,count]of [[0,548],[183,600],[234,520],[235,264]])if(rows.filter(r=>r.exitCode===status).length!==count)throw Error('Incomplete directory outcomes');
 for(const row of rows){if(row.outputs.length!==row.outputPaths.length)throw Error('Missing directory output');for(const output of row.outputs)if(output){const bytes=Buffer.from(output.base64,'base64');if(bytes.length!==output.bytes||hash(bytes)!==output.sha256)throw Error('Directory output changed');}}
 return rows;
}
