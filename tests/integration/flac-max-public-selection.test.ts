import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import corpus from '../../compat/behavior-specs/flac-max-selection/cases.json' with {type:'json'};

for(const row of corpus.rows)it(`public metadata/disposition selection or explicit picture-output gap: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];let opens=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend(),budget:{maxResidentBytes:16777216,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},
  filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,7));}};},
   async openWrite(){opens++;return {async write(bytes){chunks.push(bytes.slice());},async commit(){},async abort(){chunks.length=0;}};}}});
 const result=await ffmpeg.exec(row.args);
 if(row.exitCode===0&&row.selectedStreamIds.some(id=>id>0)){
  expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/attached pictures/);expect(opens).toBe(0);return;
 }
 expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(row.exitCode);
 if(row.exitCode===0){const output=Buffer.concat(chunks);expect(createHash('sha256').update(output).digest('hex')).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);expect(opens).toBe(1);}
 else{expect(opens).toBe(0);expect(chunks).toEqual([]);}
});
