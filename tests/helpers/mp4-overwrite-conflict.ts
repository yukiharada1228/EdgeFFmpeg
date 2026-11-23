import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function overwriteConflictCases(){
 const root='compat/behavior-specs/mp4-overwrite-conflict/',read=(p:string)=>readFileSync(p),hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex'),manifest=JSON.parse(read(root+'manifest.json').toString()) as {sha256:Record<string,string>};
 for(const[name,digest]of Object.entries(manifest.sha256))if(hash(read(root+name))!==digest)throw Error('Changed overwrite artifact '+name);
 const provenance=JSON.parse(read(root+'provenance.json').toString()) as {caseCount:number;inputCount:number;reference:{commit:string};sources:Record<string,string>};
 if(provenance.caseCount!==108||provenance.inputCount!==9||provenance.reference.commit!==JSON.parse(read('compat/upstream.lock.json').toString()).commit)throw Error('Changed overwrite reference');for(const[name,digest]of Object.entries(provenance.sources))if(hash(read(name))!==digest)throw Error('Changed overwrite source '+name);
 const rows=JSON.parse(read(root+'results.json').toString()) as {inputId:string;map:string;flags:string[];existing:boolean;exitCode:number;reason:string;outputExists:boolean;outputUnchanged:boolean|null}[];
 const key=(row:typeof rows[number])=>JSON.stringify([row.inputId,row.map,row.flags,row.existing]);
 if(rows.length!==108||new Set(rows.map(key)).size!==108||new Set(rows.map(row=>row.inputId)).size!==9||rows.some(row=>row.exitCode!==234||row.reason!=='Error, both -y and -n supplied. Exiting.'||row.outputExists!==row.existing||row.outputUnchanged!==(row.existing?true:null)))throw Error('Incomplete overwrite corpus');return rows;
}
