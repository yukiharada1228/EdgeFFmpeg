import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluateSimpleVideoCase} from '../helpers/video-streamcopy.js';
import type {SimpleVideoCase} from '../helpers/video-streamcopy.js';
import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
const groups=[{high:false,count:2280,name:'matches 2280 Native streamcopy option and packet clock jobs'},{high:true,count:240,name:'matches 240 Native high-rate streamcopy option and packet clock jobs'}];
for(const group of groups)it(group.name,async()=>{
 const root='compat/behavior-specs/video-streamcopy',hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex'),manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {sha256:Record<string,number[]>};for(const [file,digest]of Object.entries(manifest.sha256))expect(hash(file),file).toBe(digest);
 const provenance=JSON.parse(readFileSync(root+'/provenance.json','utf8')) as {reference:{commit:string};numericProfile:ExpressionNumericProfile;sources:Record<string,number[]>};expect(provenance.reference.commit).toBe(JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit);for(const [file,digest]of Object.entries(provenance.sources))expect(hash(file),file).toBe(digest);
 const cases=JSON.parse(readFileSync(root+'/cases.json','utf8')) as SimpleVideoCase[],results=JSON.parse(readFileSync(root+'/results.json','utf8')) as {exitCode:number;rows:Record<string,number[]>}[];expect(cases).toHaveLength(2520);expect(results).toHaveLength(cases.length);const selected=cases.map((row,index)=>({row,index})).filter(({row})=>row.id.startsWith('streamcopy-high-rate-')===group.high);expect(selected).toHaveLength(group.count);
 for(const {row,index}of selected){const actual=await evaluateSimpleVideoCase(row,provenance.numericProfile);expect(actual.exitCode,row.id+' '+JSON.stringify(actual.diagnostics)).toBe(results[index]!.exitCode);expect(actual.rows,row.id).toEqual(results[index]!.rows);expect(actual.outputs,row.id).toEqual(Object.keys(results[index]!.rows));expect(actual.pending).toBe(0);expect(actual.storesClosed).toBe(true);expect(Object.values(actual.reads).every(count=>count===1)).toBe(true);if(actual.exitCode!==0)expect(actual.reads).toEqual({});}
},30000);
