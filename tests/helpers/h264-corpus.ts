import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {H264Case} from './h264.js';
export const h264Hash=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
export function loadH264Corpus(){
 const root='compat/behavior-specs/h264',data=readFileSync(root+'/cases.json'),manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8')) as {cases:number;frames:number;casesSha256:string;sourceCommit:string;fixtureSources:Record<string,string>;oracleSourceSha256:string};
 if(h264Hash(data)!==manifest.casesSha256||manifest.sourceCommit!==JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit)throw Error('H264 corpus/reference mismatch');
 for(const [path,digest]of Object.entries(manifest.fixtureSources))if(h264Hash(readFileSync(path))!==digest)throw Error('H264 fixture source changed: '+path);
 if(h264Hash(readFileSync('tools/differential-runner/h264/oracle.c'))!==manifest.oracleSourceSha256)throw Error('H264 oracle source changed');
 const rows=JSON.parse(data.toString()) as H264Case[];
 if(rows.length!==manifest.cases||rows.reduce((n,r)=>n+r.expected.length,0)!==manifest.frames)throw Error('Incomplete H264 corpus');
 for(const row of rows)if(h264Hash(Buffer.concat(row.packets.map(s=>Buffer.from(s,'base64'))))!==row.inputSha256)throw Error('H264 input changed: '+row.id);
 return rows;
}
export function loadH264Module(){
 const bytes=readFileSync('.build/codecs/openh264/openh264.wasm'),lock=JSON.parse(readFileSync('tools/codecs/openh264/build.lock.json','utf8')) as {expectedWasmSha256:string};
 if(h264Hash(bytes)!==lock.expectedWasmSha256)throw Error('H264 codec build differs from lock');
 return new Uint8Array(bytes);
}
