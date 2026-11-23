import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {AudioEditResult} from './mp4-audio-edits.js';
interface AacEntryInput {id:string;sourceId:string;mode:string;input:string;sha256:string}
interface EntryHeader {tag:string;version:number;channels:number;rateWord:number}
interface AacEntryResult extends Omit<AudioEditResult,'input'|'copy'> {input:AudioEditResult['input']&{entryHeader:EntryHeader};copy:NonNullable<AudioEditResult['copy']>&{entryHeader:EntryHeader}}
export function loadMp4AacEntries() {
 const root='compat/behavior-specs/mp4-aac-entries/',read=(p:string)=>readFileSync(p),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
 const manifest=JSON.parse(read(root+'manifest.json').toString()) as {sha256:Record<string,string>};
 for(const [name,digest] of Object.entries(manifest.sha256))if(hash(read(root+name))!==digest)throw Error('Changed audio interval artifact '+name);
 const provenance=JSON.parse(read(root+'provenance.json').toString()) as {reference:{commit:string};caseCount:number;sources:Record<string,string>};
 if(provenance.reference.commit!==JSON.parse(read('compat/upstream.lock.json').toString()).commit)throw Error('Changed audio interval reference');
 for(const [name,digest] of Object.entries(provenance.sources))if(hash(read(name))!==digest)throw Error('Changed audio interval source '+name);
 const inputs=JSON.parse(read(root+'inputs.json').toString()) as AacEntryInput[],results=JSON.parse(read(root+'results.json').toString()) as AacEntryResult[];
 if(inputs.length!==108||results.length!==108||provenance.caseCount!==108||new Set(inputs.map(r=>r.id)).size!==108||new Set(results.map(r=>r.id)).size!==108)throw Error('Incomplete audio interval corpus');
 for(const row of inputs)if(hash(Buffer.from(row.input,'base64'))!==row.sha256||!results.some(r=>r.id===row.id&&r.copy))throw Error('Changed audio interval input '+row.id);
 return {inputs,results};
}
export function aacEntryCopyJobs(){const fixture=loadMp4AacEntries();return fixture.inputs.map(row=>({...row,options:['-map','0:a:0'],expected:fixture.results.find(r=>r.id===row.id)!.copy!}));}
