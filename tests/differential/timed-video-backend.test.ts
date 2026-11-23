import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluateMemoryTimedVideo} from '../helpers/timed-video-backend.js';
import type {TimedVideoCase} from '../helpers/timed-video-backend.js';
import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
it('matches 1134 pinned Native crop and scale CLI outputs through the public timed video backend',async()=>{
 const root='compat/behavior-specs/timed-video-backend',hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex'),manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {sha256:Record<string,string>};for(const [file,digest]of Object.entries(manifest.sha256))expect(hash(file),file).toBe(digest);
 const provenance=JSON.parse(readFileSync(root+'/provenance.json','utf8')) as {numericProfile:ExpressionNumericProfile;reference:{commit:string};sources:Record<string,string>};expect(provenance.reference.commit).toBe(JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit);for(const [file,digest]of Object.entries(provenance.sources))expect(hash(file),file).toBe(digest);
 const cases=JSON.parse(readFileSync(root+'/cases.json','utf8')) as TimedVideoCase[],results=JSON.parse(readFileSync(root+'/results.json','utf8')) as string[];expect(cases).toHaveLength(1134);expect(results).toHaveLength(cases.length);
 for(const [index,row]of cases.entries()){const actual=await evaluateMemoryTimedVideo(row,provenance.numericProfile);expect(actual,JSON.stringify(row)).toEqual({exitCode:0,outputs:['/output/out'],diagnostics:[],text:results[index],pending:0,storesClosed:true});}
},30000);
