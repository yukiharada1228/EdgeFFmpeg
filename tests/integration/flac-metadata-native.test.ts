import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import {readFlacMetadata} from '@edge-ffmpeg/containers';
interface Row {id:string;input:string;inputSha256:string;expected:{sampleRate:number;channels:number;bitsPerSample:number;totalSamples:number|null;timeBase:string}}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
it('matches 18 pinned Native clean FLAC stream parameter cases with three short-read schedules',async()=>{
 const base=new URL('../../compat/behavior-specs/flac-metadata/',import.meta.url);
 const raw=readFileSync(new URL('cases.json',base));
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8')) as {casesSha256:string};
 expect(sha(raw)).toBe(manifest.casesSha256);
 const corpus=JSON.parse(raw.toString()) as {rows:Row[]};expect(corpus.rows).toHaveLength(18);
 for(const row of corpus.rows)for(const cap of [1,7,34]){
  const bytes=Buffer.from(row.input,'base64');expect(sha(bytes),row.id).toBe(row.inputSha256);
  const signal=new AbortController().signal;
  const resources=new ResourceContext({maxResidentBytes:34,maxBufferBytes:34,maxCpuTimeMs:1000,maxPendingPackets:1},signal);
  let largestRead=0;
  const result=await readFlacMetadata({size:BigInt(bytes.length),async readAt(offset,length){largestRead=Math.max(largestRead,length);return bytes.subarray(Number(offset),Number(offset)+Math.min(cap,length));}},{resources,signal,maxReadBytes:cap});
  expect(result.kind,row.id).toBe('flac-streaminfo');
  if(result.kind!=='flac-streaminfo'||!result.streamInfo)throw Error('Missing STREAMINFO');
  const info=result.streamInfo;
  expect({sampleRate:info.sampleRate,channels:info.channels,bitsPerSample:info.bitsPerSample,totalSamples:info.totalSamplesKnown?Number(info.totalSamples):null,timeBase:info.timeBase?`${info.timeBase.num}/${info.timeBase.den}`:null},row.id).toEqual(row.expected);
  expect(result.directoryComplete).toBe(true);expect(result.framesOffset).not.toBeNull();
  expect(result.unparsedMetadataTypes).toContain(4);expect(result.metadataValidationComplete).toBe(false);
  expect(largestRead).toBeLessThanOrEqual(cap);expect(resources.allocatedBytes).toBe(0);
 }
});
