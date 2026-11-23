import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {ResourceContext} from '@edge-ffmpeg/core';
import {openFlacDemux} from '../../packages/containers/src/flac/demux.js';
import corpus from '../../compat/behavior-specs/flac-demux/clean.json' with {type:'json'};
it('matches preserved finite Native clean packet bytes and sample timing',async()=>{
 for(const row of corpus.rows)for(const cap of [1,7,34]){
  const bytes=Buffer.from(row.flac,'base64');expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
  const signal=new AbortController().signal,resources=new ResourceContext({maxResidentBytes:65536,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:8},signal);
  const demux=await openFlacDemux({size:BigInt(bytes.length),async readAt(offset,length){return bytes.subarray(Number(offset),Number(offset)+Math.min(length,cap));}},{signal,resources,maxReadBytes:cap,maxPacketBytes:65536n,maxScanBytes:65536n});let index=0;
  for await(const packet of demux.packets){const ref=row.packets[index++]!;expect(packet.pts).toBe(ref.pts===undefined?null:BigInt(ref.pts));expect(packet.dts).toBe(ref.dts===undefined?null:BigInt(ref.dts));expect(packet.duration).toBe(ref.duration===undefined?null:BigInt(ref.duration));const hash=createHash('sha256');let length=0;for await(const chunk of packet.chunks){hash.update(chunk.data);length+=chunk.data.length;chunk.release();}expect(length).toBe(Number(ref.size));expect(hash.digest('hex')).toBe(createHash('sha256').update(bytes.subarray(Number(ref.pos),Number(ref.pos)+Number(ref.size))).digest('hex'));}
  expect(index).toBe(row.packets.length);expect(Object.isFrozen(demux.metadata)).toBe(true);await demux.close();expect(resources.allocatedBytes).toBe(0);
 }
});
import metadataCorpus from '../../compat/behavior-specs/flac-demux/metadata.json' with {type:'json'};
it('preserves Native ordered metadata dictionaries, chapters and mixed picture order',async()=>{
 for(const row of metadataCorpus.rows){
  const bytes=Buffer.from(row.input,'base64');expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.inputSha256);
  const signal=new AbortController().signal,resources=new ResourceContext({maxResidentBytes:65536,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:8},signal);
  const demux=await openFlacDemux({size:BigInt(bytes.length),async readAt(offset,length){return bytes.subarray(Number(offset),Number(offset)+Math.min(length,7));}},{signal,resources,maxReadBytes:7,maxPacketBytes:65536n,maxScanBytes:65536n});
  try{expect(demux.metadata.tags,row.id).toEqual(row.native.tags);
   if('tagEntries' in row.native)expect(demux.metadata.tagEntries,row.id).toEqual(row.native.tagEntries);
   if('chapters' in row.native){expect(demux.metadata.chapters.map(c=>({id:c.id,start:String(c.start),end:String(c.end),tags:c.tags})),row.id).toEqual(row.native.chapters.map(c=>({id:c.id,start:String(c.start),end:String(c.end),tags:'tags' in c?c.tags:{}})));}
   if('pictures' in row.native){expect(demux.attachedPictures.length).toBe(row.native.pictures.length);for(const [i,image]of demux.attachedPictures.entries()){const ref=row.native.pictures[i]!;expect(image.descriptor.kind).toBe('accepted');if(image.descriptor.kind==='accepted'){expect(image.descriptor.codec).toBe(ref.codec_name);expect(image.descriptor.tags).toEqual(ref.tags);}for await(const chunk of image.chunks)chunk.release();}}
   for await(const packet of demux.packets)for await(const chunk of packet.chunks)chunk.release();
  }finally{await demux.close();}expect(resources.allocatedBytes).toBe(0);
 }
});
