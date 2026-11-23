import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import corpus from '../../compat/behavior-specs/flac-max-remux/cases.json' with {type:'json'};

// Existing-file -n and duplicate streams have distinct Native exit policies;
// the helper's independent suite retains those observations separately.
for(const row of corpus.rows.filter(row=>row.id!=='overwrite-n'&&row.exitCode===0))it(`public FLAC packet-copy route matches Native bytes without a decoder: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];
 const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
 expect(hash(input)).toBe(row.inputSha256);
 let commits=0,aborts=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend(),budget:{maxResidentBytes:16777216,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:15000},
  filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,row.id==='short-read-1'?1:7));}};},
   async openWrite(){return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){aborts++;chunks.length=0;}};}}});
 // Native file-protocol blocksize is represented by the virtual provider's
 // 1/7-byte readAt above; it is not a supported virtual-backend CLI option.
 const args=row.args.filter((arg,index,argv)=>arg!=='-blocksize'&&argv[index-1]!=='-blocksize');
 const result=await ffmpeg.exec(args);
 expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(row.exitCode);
 const output=Buffer.concat(chunks);expect(hash(output)).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);
 expect(commits).toBe(1);expect(aborts).toBe(0);
});
