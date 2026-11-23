import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import corpus from '../../compat/behavior-specs/flac-decoded-selection/cases.json' with {type:'json'};

const input=Buffer.from(corpus.input,'base64');
const module=new WebAssembly.Module(readFileSync('.build/codecs/flac/edge-flac.wasm'));
it('pins independently observed decoded FLAC map selection input',()=>{
 expect(createHash('sha256').update(input).digest('hex')).toBe(corpus.inputSha256);
 expect(corpus.reference).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');
 expect(corpus.rows).toHaveLength(13);
});
for(const row of corpus.rows)it(`matches Native decoded audio selection ${row.id}: ${row.maps.join(',')}`,async()=>{
 const chunks:Uint8Array[]=[];let sourceOpens=0,outputOpens=0,commits=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module,maxReadBytes:31}}),budget:{maxResidentBytes:33554432,maxBufferBytes:4096,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{
  async openRead(){sourceOpens++;return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(7,length));}};},
  async openWrite(){outputOpens++;return {async write(chunk){chunks.push(chunk.slice());},async commit(){commits++;},async abort(){}};},
 }});
 const result=await ffmpeg.exec(row.args);
 expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(row.exitCode);
 expect(sourceOpens).toBe(1);
 if(row.exitCode===0){expect(Buffer.concat(chunks).toString('base64')).toBe(row.output);expect(result.outputs).toEqual(['/out']);expect(commits).toBe(1);}
 else{expect(outputOpens).toBe(0);expect(commits).toBe(0);expect(result.outputs).toEqual([]);}
});
