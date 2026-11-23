import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluateThreadFrame} from '../helpers/thread-frame-queue.js';
import type {ThreadFrameCase} from '../helpers/thread-frame-queue.js';
it('matches 120 cached Native frame FIFO traces through the public queue API',()=>{
 const root='compat/behavior-specs/thread-frame-queue',sha=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
 const manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {sha256:Record<string,string>;observations:number};
 for(const [file,hash]of Object.entries(manifest.sha256))expect(sha(file)).toBe(hash);
 const provenance=JSON.parse(readFileSync(root+'/host-provenance.json','utf8'));
 expect(provenance.oracle.reference.commit).toBe(JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit);
 expect(sha('upstream/ffmpeg/fftools/thread_queue.c')).toBe(provenance.oracle.sourceDependencySha256);
 expect(sha('tools/differential-runner/thread-frame-queue/oracle.c')).toBe(provenance.oracle.sourceSha256);
 const cases=JSON.parse(readFileSync(root+'/cases.json','utf8')) as ThreadFrameCase[],native=JSON.parse(readFileSync(root+'/results.json','utf8'));
 expect(cases).toHaveLength(120);expect(cases.reduce((sum,row)=>sum+row.ops.length,0)).toBe(manifest.observations);
 for(const [index,row]of cases.entries())expect(evaluateThreadFrame(row),'case '+index).toEqual(native[index]);
});
