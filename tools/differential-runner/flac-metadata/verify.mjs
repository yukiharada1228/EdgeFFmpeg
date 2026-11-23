import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../../..'),base=resolve(root,'compat/behavior-specs/flac-metadata');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const raw=readFileSync(resolve(base,'cases.json')),manifest=JSON.parse(readFileSync(resolve(base,'manifest.json'),'utf8')),corpus=JSON.parse(raw);
assert.equal(sha(raw),manifest.casesSha256);
const binary=resolve(root,'.build/reference/ffprobe');
assert.equal(sha(readFileSync(binary)),corpus.reference.artifacts.ffprobe);
for(const row of corpus.rows){
 const input=Buffer.from(row.input,'base64');assert.equal(sha(input),row.inputSha256);
 const result=spawnSync(binary,['-v','error','-show_streams','-of','json','pipe:0'],{input,timeout:10000,maxBuffer:1024*1024});
 assert.ifError(result.error);assert.equal(result.status,0,String(result.stderr));
 const streams=JSON.parse(result.stdout).streams;assert.equal(streams.length,1);const s=streams[0];
 assert.deepEqual({sampleRate:Number(s.sample_rate),channels:s.channels,bitsPerSample:Number(s.bits_per_raw_sample),totalSamples:s.duration_ts??null,timeBase:s.time_base},row.expected,row.id);
}
console.log(`Verified ${corpus.rows.length} pinned Native metadata cases`);
