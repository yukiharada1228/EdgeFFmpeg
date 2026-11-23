import {test,expect} from 'vitest';
import {ResourceContext} from '../../packages/core/src/resources.js';
import {createReferenceBase64Source} from '../../packages/containers/src/flac/base64-source.js';
import {readFlacPictureRange} from '../../packages/containers/src/flac/picture-reader.js';
import {readFlacPacketChunks} from '../../packages/containers/src/flac/payload.js';
import corpus from '../../compat/behavior-specs/flac-pictures/native-pictures.json' with {type:'json'};
function setup(){const controller=new AbortController(),signal=controller.signal,resources=new ResourceContext({maxResidentBytes:65536,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:1},signal);return{controller,signal,resources};}
test('Base64 picture and payload decode into bounded Core buffers without provider allocations',async()=>{
 const opts=setup(),bytes=Buffer.from(corpus.rows.find(r=>r.id==='bmp')!.payload,'base64'),source=createReferenceBase64Source(bytes.toString('base64'),{signal:opts.signal,maxReadBytes:7})!;
 source.readAt=async()=>{throw Error('provider readAt forbidden');};
 const picture=await readFlacPictureRange(source,{...opts,payloadOffset:0n,payloadBytes:bytes.length,maxReadBytes:7});
 expect(picture.descriptor.kind).toBe('accepted');expect(opts.resources.allocatedBytes).toBe(0);
 const range=picture.dataRange!,reader=readFlacPacketChunks(source,range,{...opts,maxReadBytes:7,maxPacketBytes:range.bytes});
 const original=source.readInto;source.readInto=()=>{throw Error('must capture reader');};
 const parts:Buffer[]=[];for await(const chunk of reader){parts.push(Buffer.from(chunk.data));chunk.release();expect(opts.resources.allocatedBytes).toBe(0);}
 expect(Buffer.concat(parts)).toEqual(bytes.subarray(Number(range.sourceOffset),Number(range.sourceOffset+range.bytes)));
 expect(reader.metrics.peakOwnedBufferBytes).toBeLessThanOrEqual(7);expect(reader.metrics.ownedBufferBytes).toBe(0);expect(picture.metrics.peakOwnedBufferBytes).toBeLessThanOrEqual(65536);
 expect(source.metrics.providerAllocatedBytes).toBe(0n);expect(source.metrics.readAtCalls).toBe(0);expect(source.metrics.readIntoCalls).toBeGreaterThan(0);source.readInto=original;
});
test('Base64 synchronous reads preserve unaligned bytes, bounds, accounting and cancellation',async()=>{
 const opts=setup(),source=createReferenceBase64Source('AAECAwQFBgcICQ==',{signal:opts.signal,maxReadBytes:7})!,destination=new Uint8Array(7).fill(255);
 expect(source.readInto(7n,destination)).toBe(3);expect([...destination]).toEqual([7,8,9,255,255,255,255]);
 expect(await source.readAt(1n,3)).toEqual(new Uint8Array([1,2,3]));expect(source.metrics.providerAllocatedBytes).toBe(3n);expect(source.metrics.generatedBytes).toBe(6n);
 expect(()=>source.readInto(11n,destination)).toThrow(RangeError);opts.controller.abort('cancel');expect(()=>source.readInto(0n,destination)).toThrow();expect(source.metrics.generatedBytes).toBe(6n);expect(opts.resources.allocatedBytes).toBe(0);
});
for(const returned of [0,-1,9,NaN,1.5])test(`readInto rejects invalid length ${returned} and releases`,async()=>{
 const opts=setup(),source={size:100n,async readAt(){throw Error('forbidden');},readInto(){return returned;}};
 await expect(readFlacPacketChunks(source,{sourceOffset:0n,bytes:8n},{...opts,maxPacketBytes:8n})[Symbol.asyncIterator]().next()).rejects.toThrow('Invalid');expect(opts.resources.allocatedBytes).toBe(0);
 await expect(readFlacPictureRange(source,{...opts,payloadOffset:0n,payloadBytes:100,maxReadBytes:8})).rejects.toThrow('Invalid');expect(opts.resources.allocatedBytes).toBe(0);
});
test('abort inside synchronous read defers release until return and then frees ownership',async()=>{
 for(const picture of [false,true]){const opts=setup(),reason=Error('cancel'),source={size:100n,async readAt(){throw Error('forbidden');},readInto(_offset:bigint,destination:Uint8Array){opts.controller.abort(reason);expect(opts.resources.allocatedBytes).toBeGreaterThan(0);destination.fill(7);return destination.length;}};
 const pending=picture?readFlacPictureRange(source,{...opts,payloadOffset:0n,payloadBytes:100}):readFlacPacketChunks(source,{sourceOffset:0n,bytes:8n},{...opts,maxPacketBytes:8n})[Symbol.asyncIterator]().next();
 await expect(pending).rejects.toBe(reason);expect(opts.resources.allocatedBytes).toBe(0);}
});
