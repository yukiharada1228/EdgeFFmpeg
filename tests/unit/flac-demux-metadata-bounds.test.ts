import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import {readFlacDemuxMetadata} from '../../packages/containers/src/flac/metadata-context.js';
it('rejects total effective picture metadata overflow before reading the continuation image',async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/flac-demux-workers/large.json','utf8')) as {recipe:{prefix:string;suffix:string;bytes:number};native:{input:{effectivePayloadBytes:number}}};
 const prefix=Buffer.from(fixture.recipe.prefix,'base64'),suffix=Buffer.from(fixture.recipe.suffix,'base64'),size=fixture.recipe.bytes;
 const signal=new AbortController().signal,resources=new ResourceContext({maxResidentBytes:65536,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:8},signal);let maximumRead=0;
 const source={size:BigInt(size),async readAt(offset:bigint,length:number){maximumRead=Math.max(maximumRead,length);const start=Number(offset),out=new Uint8Array(Math.min(length,size-start));for(let i=0;i<out.length;i++){const position=start+i;if(position<prefix.length)out[i]=prefix[position]!;else if(position>=size-suffix.length)out[i]=suffix[position-(size-suffix.length)]!;}return out;}};
 await expect(readFlacDemuxMetadata(source,{resources,signal,maxPictureBytes:33554432,maxMetadataBytes:BigInt(fixture.native.input.effectivePayloadBytes)})).rejects.toThrow('continuation bounds exceeded');
 expect(maximumRead).toBeLessThanOrEqual(34);expect(resources.allocatedBytes).toBe(0);
});
