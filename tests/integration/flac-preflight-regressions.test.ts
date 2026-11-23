import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import pictures from '../../compat/behavior-specs/flac-decoded-selection/aiff-pictures.json' with {type:'json'};
import decoded from '../../compat/behavior-specs/flac-decode-cli/cases.json' with {type:'json'};
const module=new WebAssembly.Module(readFileSync('.build/codecs/flac/edge-flac.wasm'));
function setup(input:Uint8Array){
 let opens=0,commits=0;const chunks:Uint8Array[]=[];
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,31));}};},async openWrite(){opens++;return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){}};}}});
 return {ffmpeg,get opens(){return opens;},get commits(){return commits;},bytes:()=>Buffer.concat(chunks)};
}
it('rejects an automatically selected AIFF attached picture before output instead of silently dropping it',async()=>{
 const input=Buffer.from(pictures.input,'base64'),native=pictures.rows.find(row=>row.id==='automatic')!;
 expect(createHash('sha256').update(input).digest('hex')).toBe(pictures.inputSha256);
 // This pinned build lacks PNG encoding: the default AIFF video stream is
 // selected, then fails before FFmpeg prints its final stream-mapping section.
 expect(native.exitCode).toBe(8);expect(native.stderr).toMatch(/Default encoder for format aiff \(codec png\)/);
 const run=setup(input),result=await run.ffmpeg.exec(native.args);
 expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/attached pictures/);expect(run.opens).toBe(0);expect(run.commits).toBe(0);
});
for(const row of pictures.rows.filter(row=>row.id!=='automatic'))it(`preserves exact Native AIFF audio when picture selection is disabled: ${row.id}`,async()=>{
 const run=setup(Buffer.from(pictures.input,'base64')),result=await run.ffmpeg.exec(row.args);
 expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(row.exitCode);expect(run.bytes().toString('base64')).toBe(row.output);expect(run.commits).toBe(1);
});
it('rejects a declared RF64-sized FLAC WAV before opening any output transaction',async()=>{
 const row=decoded.rows.find(row=>row.id==='16-2-extremes-5/wav')!,input=Buffer.from(row.input,'base64');
 input.writeBigUInt64BE((input.readBigUInt64BE(18)&~((1n<<36n)-1n))|0x100000000n,18);
 const run=setup(input),result=await run.ffmpeg.exec(row.args);
 expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/RF64/);expect(run.opens).toBe(0);expect(run.commits).toBe(0);
});
