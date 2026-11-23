import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {evaluateEncoderSync} from '../helpers/encoder-sync-queue.js';
import type {EncoderSyncCase} from '../helpers/encoder-sync-queue.js';
it('matches 110 complete cached Native video encoder synchronization traces through the public queue API',()=>{
 const root='compat/behavior-specs/video-encoder-sync',hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex'),manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {sha256:Record<string,string>};
 for(const [file,digest]of Object.entries(manifest.sha256))expect(hash(readFileSync(file))).toBe(digest);
 const provenance=JSON.parse(readFileSync(root+'/host-provenance.json','utf8'));expect(provenance.oracle.reference.commit).toBe(JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit);expect(hash(readFileSync('upstream/ffmpeg/fftools/sync_queue.c'))).toBe(provenance.oracle.sourceDependencySha256);
 const traceText=gunzipSync(readFileSync(root+'/results.jsonl.gz')).toString();expect(hash(traceText)).toBe(provenance.traceLinesSha256);
 const lines=traceText.trimEnd().split('\n'),digests=JSON.parse(readFileSync(root+'/trace-sha256.json','utf8')) as string[],cases=JSON.parse(readFileSync(root+'/cases.json','utf8')) as EncoderSyncCase[];
 expect(cases).toHaveLength(110);expect(lines).toHaveLength(cases.length);expect(digests).toHaveLength(cases.length);expect(cases.reduce((n,row)=>n+row.ops.length,0)).toBe(21575);
 let heartbeatChanges=0;
 for(const [index,row]of cases.entries()){
  expect(hash(lines[index]!),'reference '+index).toBe(digests[index]);const actual=evaluateEncoderSync(row);expect(hash(JSON.stringify(actual)),'case '+index).toBe(digests[index]);
  for(let step=1;step<row.ops.length;step++)if(row.ops[step]![0]==='r'&&actual[step]!.state.streams.some((stream,pad)=>stream.head!==actual[step-1]!.state.streams[pad]!.head))heartbeatChanges++;
 }
 expect(heartbeatChanges).toBeGreaterThan(0);
});
