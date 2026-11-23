import { expect, it } from 'vitest';
import { ResourceContext } from '@edge-ffmpeg/core';
import type { ReadHandle } from '@edge-ffmpeg/core';
import { readFlacMetadata, FlacMetadataError } from '../../packages/containers/src/flac/metadata.js';
import type { FlacMetadataOptions } from '../../packages/containers/src/flac/metadata-types.js';
const marker = [102,76,97,67];
function block(type: number, payload: Uint8Array, last = true) { return [type | (last ? 128 : 0), payload.length >> 16, payload.length >> 8 & 255, payload.length & 255, ...payload]; }
function info(rate = 48000, samples = 0x123456789n) {
 const bytes = new Uint8Array(34), view = new DataView(bytes.buffer);
 view.setUint16(0, 16); view.setUint16(2, 4096); bytes.set([1,2,3,4,5,6],4);
 view.setBigUint64(10, BigInt(rate) << 44n | 7n << 41n | 23n << 36n | samples);
 bytes.fill(0xab,18); return bytes;
}
function setup(bytes: Uint8Array, extra: Partial<FlacMetadataOptions> = {}, readAt?: ReadHandle['readAt']) {
 const controller = new AbortController(), resources = new ResourceContext({maxResidentBytes:34,maxBufferBytes:34,maxCpuTimeMs:1000,maxPendingPackets:1}, new AbortController().signal);
 const pending = readFlacMetadata({size:BigInt(bytes.length),readAt: readAt ?? (async (offset,length) => bytes.slice(Number(offset),Number(offset)+length))},{resources,signal:controller.signal,...extra});
 return {pending,controller,resources};
}
it('extracts every STREAMINFO field with short reads and immutable descriptors', async () => {
 const bytes = new Uint8Array([...marker,...block(0,info())]), s = setup(bytes, {maxReadBytes:3}, async (offset) => bytes.slice(Number(offset),Number(offset)+1));
 const result = await s.pending;
 expect(result.kind).toBe('flac-streaminfo'); if(result.kind !== 'flac-streaminfo') throw Error('kind');
 expect(result.streamInfo).toEqual({codec:'flac',minBlockSamples:16,maxBlockSamples:4096,minFrameBytes:66051,maxFrameBytes:263430,sampleRate:48000,channels:8,bitsPerSample:24,totalSamples:0x123456789n,totalSamplesKnown:true,md5:'ab'.repeat(16),timeBase:{num:1n,den:48000n}});
 expect(result.framesOffset).toBe(42n); expect(result.advertisedMetadataBytes).toBe(38n); expect(result.effectiveMetadataBytes).toBe(38n);
 expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.blocks)).toBe(true); expect(Object.isFrozen(result.blocks[0])).toBe(true); expect(Object.isFrozen(result.streamInfo?.timeBase)).toBe(true); expect(s.resources.allocatedBytes).toBe(0);
});
it('preserves zero and unrestricted encoded fields rather than applying probe rules', async () => {
 const s = setup(new Uint8Array([...marker,...block(0,new Uint8Array(34))])); const r = await s.pending;
 if(r.kind !== 'flac-streaminfo') throw Error('kind'); expect(r.streamInfo).toMatchObject({sampleRate:0,totalSamples:0n,totalSamplesKnown:false,timeBase:null,channels:1,bitsPerSample:1}); expect(s.resources.allocatedBytes).toBe(0);
});
it.each([1,2,4,7,127])('rejects generic type %s before STREAMINFO', async type => {
 const s = setup(new Uint8Array([...marker,...block(type,new Uint8Array())])); await expect(s.pending).rejects.toMatchObject({code:'invalid-data'}); expect(s.resources.allocatedBytes).toBe(0);
});
it.each([3,5])('records unvalidated type %s before STREAMINFO under Native dispatch ordering', async type => {
 const s = setup(new Uint8Array([...marker,...block(type,new Uint8Array(),false),...block(0,info())])); const r = await s.pending;
 if(r.kind !== 'flac-streaminfo') throw Error('kind'); expect(r.unparsedMetadataTypes).toEqual([type]); expect(r.metadataValidationComplete).toBe(false); expect(r.directoryComplete).toBe(true);
});
it('does not invent a missing STREAMINFO rejection for a last seek table', async () => {
 const r = await setup(new Uint8Array([...marker,...block(3,new Uint8Array())])).pending;
 if(r.kind !== 'flac-streaminfo') throw Error('kind'); expect(r.streamInfo).toBeNull(); expect(r.metadataValidationComplete).toBe(false);
});
it('stops at unhandled pictures without claiming an effective audio offset, even if last', async () => {
 for (const last of [false,true]) {
 const s = setup(new Uint8Array([...marker,...block(0,info(),false),...block(6,new Uint8Array(2),last),...block(0,info())])); const r = await s.pending;
 if(r.kind !== 'flac-streaminfo') throw Error('kind'); expect(r.framesOffset).toBeNull(); expect(r.effectiveMetadataBytes).toBeNull(); expect(r.directoryComplete).toBe(false); expect(r.continuation).toEqual({kind:'unhandled-picture',blockIndex:1,advertisedNextOffset:48n}); expect(r.blocks[1]?.effectiveEndOffset).toBeNull(); expect(r.blocks).toHaveLength(2); expect(s.resources.allocatedBytes).toBe(0);
 }
});
it.each([
 [...marker,...block(0,info(),false),...block(0,info())],
 [...marker,...block(0,new Uint8Array(33))],
 [...marker,128,0,0,34,0], [...marker,128,0],
 [...marker,...block(0,info(),false)]
].map(bytes => ({bytes})))('rejects duplicate, wrong-size and truncated metadata', async ({bytes}) => {
 const s = setup(new Uint8Array(bytes)); await expect(s.pending).rejects.toBeInstanceOf(FlacMetadataError); expect(s.resources.allocatedBytes).toBe(0);
});
it.each([{maxMetadataBytes:37n},{maxMetadataBlocks:0},{maxReadBytes:0},{maxMetadataBytes:-1n},{maxReadBytes:1048577}])('enforces configured limits', async extra => {
 const s = setup(new Uint8Array([...marker,...block(0,info())]),extra); await expect(s.pending).rejects.toMatchObject({code:'resource-limit'}); expect(s.resources.allocatedBytes).toBe(0);
});
it('enforces block count across otherwise skippable blocks', async () => {
 const s = setup(new Uint8Array([...marker,...block(0,info(),false),...block(1,new Uint8Array())]),{maxMetadataBlocks:1}); await expect(s.pending).rejects.toMatchObject({code:'resource-limit'}); expect(s.resources.allocatedBytes).toBe(0);
});
it.each([[],[255],[255,248,9],[255,248,10,0]].map(bytes => ({bytes})))('returns raw fallback with zero-padded Native rate hint $bytes', async ({bytes}) => {
 const s = setup(new Uint8Array(bytes)); const r = await s.pending; expect(r).toEqual({kind:'raw-frame-fallback',framesOffset:0n,sampleRateHint:bytes[2] === 9 ? 44100 : bytes[2] === 10 ? 48000 : null,metadataValidationComplete:false}); expect(s.resources.allocatedBytes).toBe(0);
});
it.each(['empty','oversized','reject'] as const)('rejects invalid provider behavior %s', async mode => {
 const s = setup(new Uint8Array(4),{},async () => {if(mode === 'reject')throw Error('provider');return new Uint8Array(mode === 'empty' ? 0 : 5);}); await expect(s.pending).rejects.toMatchObject({code:'input-read'}); expect(s.resources.allocatedBytes).toBe(0);
});
function deferred<T>() { let resolve!:(value:T)=>void, reject!:(error:unknown)=>void; const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
it.each(['read','checkpoint'] as const)('interrupts a never-settling %s and observes late resolve/reject', async mode => {
 for(const late of ['resolve','reject']) {
 const gate = deferred<Uint8Array>(), entered = deferred<void>();
 const s = setup(new Uint8Array(4), mode === 'checkpoint' ? {checkpoint:()=>{entered.resolve();return gate.promise.then(()=>{});}} : {}, mode === 'read' ? ()=>{entered.resolve();return gate.promise;} : undefined);
 const reason = {cancel:mode}, rejected = expect(s.pending).rejects.toBe(reason); await entered.promise; expect(s.resources.allocatedBytes).toBe(4); s.controller.abort(reason); expect(s.resources.allocatedBytes).toBe(0); await rejected;
 if(late === 'resolve')gate.resolve(new Uint8Array(4));else gate.reject(Error('late')); await new Promise(resolve=>setImmediate(resolve)); expect(s.resources.allocatedBytes).toBe(0);
 }
});
it('releases STREAMINFO scratch on cancellation during a partial payload read', async () => {
 const bytes = new Uint8Array([...marker,...block(0,info())]), gate = deferred<Uint8Array>(), entered = deferred<void>();
 const s = setup(bytes, {}, async (offset,length) => {
  if(offset === 10n){entered.resolve();return gate.promise;}
  return bytes.slice(Number(offset),Number(offset) + (offset === 8n ? 2 : length));
 });
 const reason = Error('cancel partial STREAMINFO'), rejected = expect(s.pending).rejects.toBe(reason);
 await entered.promise; expect(s.resources.allocatedBytes).toBe(34); s.controller.abort(reason); expect(s.resources.allocatedBytes).toBe(0); await rejected; gate.resolve(new Uint8Array(32)); await new Promise(resolve=>setImmediate(resolve)); expect(s.resources.allocatedBytes).toBe(0);
});
it('fails an insufficient allocator budget before STREAMINFO I/O and releases all storage', async () => {
 const controller = new AbortController(), resources = new ResourceContext({maxResidentBytes:33,maxBufferBytes:33,maxCpuTimeMs:1000,maxPendingPackets:1},controller.signal);
 const bytes = new Uint8Array([...marker,...block(0,info())]); let payloadReads = 0;
 await expect(readFlacMetadata({size:BigInt(bytes.length),async readAt(offset,length){if(offset >= 8n)payloadReads++;return bytes.slice(Number(offset),Number(offset)+length);}},{resources,signal:controller.signal})).rejects.toThrow('Memory budget');
 expect(payloadReads).toBe(0); expect(resources.allocatedBytes).toBe(0);
});
it('preserves a pre-aborted signal reason without allocating or reading', async () => {
 const controller = new AbortController(), resources = new ResourceContext({maxResidentBytes:34,maxBufferBytes:34,maxCpuTimeMs:1000,maxPendingPackets:1},new AbortController().signal), reason = Error('already aborted'); controller.abort(reason); let reads = 0;
 await expect(readFlacMetadata({size:4n,async readAt(){reads++;return new Uint8Array(4);}},{resources,signal:controller.signal})).rejects.toBe(reason);
 expect(reads).toBe(0); expect(resources.allocatedBytes).toBe(0);
});
it('accepts validated comments through a frozen descriptor', async () => {
 const bytes = new Uint8Array([...marker,...block(0,info(),false),...block(4,new Uint8Array(2))]);
 const s = setup(bytes,{handleUnsupportedBlock: descriptor => {
  expect(Object.isFrozen(descriptor)).toBe(true); expect(descriptor.type).toBe(4);
  return {effectiveEndOffset:descriptor.advertisedEndOffset,payloadValidated:true};
 }});
 const r = await s.pending; if(r.kind !== 'flac-streaminfo') throw Error('kind');
 expect(r.metadataValidationComplete).toBe(true); expect(r.unparsedMetadataTypes).toEqual([]); expect(r.blocks[1]?.validation).toBe('validated'); expect(r.framesOffset).toBe(48n); expect(s.resources.allocatedBytes).toBe(0);
});
it.each([true,false])('resumes bounded picture continuation with validation %s', async payloadValidated => {
 const bytes = new Uint8Array([...marker,...block(6,new Uint8Array(2),false),9,9,9,...block(0,info())]);
 const r = await setup(bytes,{handleUnsupportedBlock: descriptor => ({effectiveEndOffset:descriptor.advertisedEndOffset+3n,payloadValidated})}).pending;
 if(r.kind !== 'flac-streaminfo') throw Error('kind');
 expect(r.blocks[0]).toMatchObject({advertisedEndOffset:10n,effectiveEndOffset:13n}); expect(r.blocks[1]?.headerOffset).toBe(13n);
 expect(r.advertisedMetadataBytes).toBe(44n); expect(r.effectiveMetadataBytes).toBe(47n); expect(r.framesOffset).toBe(51n); expect(r.directoryComplete).toBe(true); expect(r.metadataValidationComplete).toBe(payloadValidated);
});
it.each([null,undefined])('preserves explicit unknown picture offsets when handler declines with %s', async decline => {
 const r = await setup(new Uint8Array([...marker,...block(6,new Uint8Array())]),{handleUnsupportedBlock:()=>decline}).pending;
 if(r.kind !== 'flac-streaminfo') throw Error('kind'); expect(r.framesOffset).toBeNull(); expect(r.blocks[0]?.effectiveEndOffset).toBeNull(); expect(r.metadataValidationComplete).toBe(false);
});
it.each([
 {effectiveEndOffset:7n,payloadValidated:true}, {effectiveEndOffset:10n,payloadValidated:true},
 {effectiveEndOffset:8,payloadValidated:true}, {effectiveEndOffset:8n,payloadValidated:1}, false,
])('rejects invalid handler results $effectiveEndOffset', async value => {
 const s = setup(new Uint8Array([...marker,...block(6,new Uint8Array()),0]),{handleUnsupportedBlock:()=>value as never});
 await expect(s.pending).rejects.toMatchObject({code:'invalid-data'}); expect(s.resources.allocatedBytes).toBe(0);
});
it('rejects comment continuation and counts effective picture bytes across subsequent blocks', async () => {
 const comment = setup(new Uint8Array([...marker,...block(0,info(),false),...block(4,new Uint8Array()),0]),{handleUnsupportedBlock:b=>({effectiveEndOffset:b.advertisedEndOffset+1n,payloadValidated:true})});
 await expect(comment.pending).rejects.toMatchObject({code:'invalid-data'});
 for(const maxMetadataBytes of [4n,42n]) {
 const s = setup(new Uint8Array([...marker,...block(6,new Uint8Array(),false),0,...block(0,info())]),{maxMetadataBytes,handleUnsupportedBlock:b=>({effectiveEndOffset:b.advertisedEndOffset+1n,payloadValidated:true})});
 await expect(s.pending).rejects.toMatchObject({code:'resource-limit'}); expect(s.resources.allocatedBytes).toBe(0);
 }
});
it.each(['resolve','reject'])('interrupts pending handler and observes late %s', async late => {
 const gate = deferred<{effectiveEndOffset:bigint;payloadValidated:boolean}>(), entered = deferred<void>();
 const s = setup(new Uint8Array([...marker,...block(6,new Uint8Array())]),{handleUnsupportedBlock:()=>{entered.resolve();return gate.promise;}});
 const reason = Error('handler abort'), rejected = expect(s.pending).rejects.toBe(reason);
 await entered.promise; expect(s.resources.allocatedBytes).toBe(0); s.controller.abort(reason); await rejected;
 if(late === 'resolve') gate.resolve({effectiveEndOffset:8n,payloadValidated:true}); else gate.reject(Error('late handler'));
 await new Promise(resolve=>setImmediate(resolve)); expect(s.resources.allocatedBytes).toBe(0);
});

it('checks known effective extent before declining a later picture handler', async () => {
 const bytes = new Uint8Array([...marker,...block(6,new Uint8Array(),false),0,...block(6,new Uint8Array())]);
 for (const budget of [8n,9n]) {
  let calls=0;
  const s=setup(bytes,{maxMetadataBytes:budget,handleUnsupportedBlock:b=>{calls++;return calls===1?{effectiveEndOffset:b.advertisedEndOffset+1n,payloadValidated:true}:null;}});
  if(budget===8n){await expect(s.pending).rejects.toMatchObject({code:'resource-limit'});expect(calls).toBe(1);}
  else {const result=await s.pending;if(result.kind!=='flac-streaminfo')throw Error('kind');expect(result.framesOffset).toBeNull();expect(result.directoryComplete).toBe(false);expect(calls).toBe(2);}
  expect(s.resources.allocatedBytes).toBe(0);
 }
});
