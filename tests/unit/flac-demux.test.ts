import {it,expect} from 'vitest';
import {ResourceContext} from '@edge-ffmpeg/core';
import {openFlacDemux} from '../../packages/containers/src/flac/demux.js';
import {createFlacPacketTiming} from '../../packages/containers/src/flac/timing.js';
import corpus from '../../compat/behavior-specs/flac-demux/clean.json' with {type:'json'};
export function setup(){const signal=new AbortController().signal;return {signal,resources:new ResourceContext({maxResidentBytes:65536,maxBufferBytes:65536,maxCpuTimeMs:1000,maxPendingPackets:8},signal),maxScanBytes:65536n,maxPacketBytes:65536n,maxReadBytes:34};}
export function source(bytes:Uint8Array){return {size:BigInt(bytes.length),async readAt(offset:bigint,length:number){return bytes.subarray(Number(offset),Number(offset)+length);}};}
it('requires packet consumption and frees held chunks on early return',async()=>{
 const opts=setup(),demux=await openFlacDemux(source(Buffer.from(corpus.rows.find(row=>row.packets.length>0)!.flac,'base64')),opts),packets=demux.packets[Symbol.asyncIterator]();
 const item=await packets.next();expect(item.done).toBe(false);if(item.done)return;
 const chunk=await item.value.chunks[Symbol.asyncIterator]().next();expect(opts.resources.allocatedBytes).toBeGreaterThan(0);
 await expect(packets.next()).rejects.toThrow('Consume packet chunks');expect(opts.resources.allocatedBytes).toBe(0);
 if(!chunk.done)expect(()=>chunk.value.data).toThrow('released');await demux.close();await demux.close();
});
it('timing queue bounds reject and close without owned storage',()=>{expect(()=>createFlacPacketTiming({maxPendingPackets:0})).toThrow('pending limit');const timing=createFlacPacketTiming();expect(timing.finish()).toEqual([]);expect(timing.metrics.pendingPackets).toBe(0);});
it('aborts pending metadata with late provider rejection observed',async()=>{
 const controller=new AbortController(),opts=setup();let entered!:()=>void,reject!:(e:Error)=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
 const pending=openFlacDemux({size:100n,readAt(){entered();return new Promise<Uint8Array>((_,r)=>{reject=r;});}},{...opts,signal:controller.signal});const reason=new Error('cancel demux');const checked=expect(pending).rejects.toBe(reason);await ready;controller.abort(reason);await checked;reject(new Error('late'));expect(opts.resources.allocatedBytes).toBe(0);
});
import metadataCorpus from '../../compat/behavior-specs/flac-demux/metadata.json' with {type:'json'};
it('close releases a held attached picture and prevents a second chunk iterator',async()=>{
 const row=metadataCorpus.rows.find(r=>'pictures' in r.native&&r.native.pictures.length>0)!;
 const opts=setup(),demux=await openFlacDemux(source(Buffer.from(row.input,'base64')),opts),picture=demux.attachedPictures[0]!;
 const iterator=picture.chunks[Symbol.asyncIterator](),item=await iterator.next();expect(item.done).toBe(false);expect(()=>picture.chunks[Symbol.asyncIterator]()).toThrow('one-shot');
 await demux.close();expect(opts.resources.allocatedBytes).toBe(0);if(!item.done)expect(()=>item.value.data).toThrow('released');
});
it('captures source, allocator, checkpoint and limits before suspended metadata I/O',async()=>{
 const bytes=Buffer.from(corpus.rows.find(row=>row.packets.length>0)!.flac,'base64'),base=setup();
 let enter!:()=>void,resume!:()=>void,first=true,checkpoints=0;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
 const resources={allocate:base.resources.allocate.bind(base.resources),budget:{maxBufferBytes:34,maxPendingPackets:2}};
 const options={...base,resources,checkpoint:async()=>{checkpoints++;}};
 const input={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){expect(this).toBe(input);expect(length).toBeLessThanOrEqual(34);if(first){first=false;enter();await gate;}return bytes.subarray(Number(offset),Number(offset)+length);}};
 const pending=openFlacDemux(input,options);await entered;
 input.size=0n;input.readAt=async()=>{throw new Error('mutated reader');};
 options.maxPacketBytes=0n;options.maxScanBytes=0n;options.maxReadBytes=1;
 options.checkpoint=async()=>{throw new Error('mutated checkpoint');};
 resources.allocate=()=>{throw new Error('mutated allocator');};resources.budget.maxBufferBytes=1;resources.budget.maxPendingPackets=1;
 resume();const demux=await pending;
 expect(demux.metrics.timing.maxPendingPackets).toBe(2);
 let packets=0;for await(const packet of demux.packets){packets++;for await(const chunk of packet.chunks)chunk.release();}
 expect(packets).toBeGreaterThan(0);expect(checkpoints).toBeGreaterThan(1);await demux.close();expect(base.resources.allocatedBytes).toBe(0);
});
it('captures attached-picture limits before metadata awaits',async()=>{
 const row=metadataCorpus.rows.find(r=>'pictures' in r.native&&r.native.pictures.length>0)!;
 const bytes=Buffer.from(row.input,'base64'),base=setup(),options={...base,maxPictureBytes:1048576,maxPictures:32,maxPictureMetadataBytes:1048576};
 let enter!:()=>void,resume!:()=>void,first=true,intoCalls=0;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
 const input={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){if(first){first=false;enter();await gate;}return bytes.subarray(Number(offset),Number(offset)+length);},readInto(offset:bigint,target:Uint8Array){expect(this).toBe(input);intoCalls++;const data=bytes.subarray(Number(offset),Number(offset)+target.length);target.set(data);return data.length;}};
 const pending=openFlacDemux(input,options);
 await entered;input.readInto=()=>{throw new Error('mutated readInto');};options.maxPictureBytes=0;options.maxPictures=0;options.maxPictureMetadataBytes=0;resume();
 const demux=await pending;let count=0;for await(const chunk of demux.attachedPictures[0]!.chunks){count+=chunk.data.length;chunk.release();}expect(count).toBeGreaterThan(0);expect(intoCalls).toBeGreaterThan(0);await demux.close();expect(base.resources.allocatedBytes).toBe(0);
});
it('validates effective pending budgets before listener registration or I/O',async()=>{
 const base=setup();let reads=0,listeners=0;const original=base.signal.addEventListener.bind(base.signal);
 base.signal.addEventListener=(...args:Parameters<AbortSignal['addEventListener']>)=>{listeners++;original(...args);};
 for(const limit of [0,-1,NaN,1.5]){const resources={allocate:base.resources.allocate.bind(base.resources),budget:{maxBufferBytes:34,maxPendingPackets:limit}};await expect(openFlacDemux({size:1n,async readAt(){reads++;return new Uint8Array(1);}},{...base,resources})).rejects.toThrow('budget');}
 expect(reads).toBe(0);expect(listeners).toBe(0);
});
it('enforces the captured Core bound on the real initial timing queue',async()=>{
 // Junk before the first valid frame is emitted by the parser with unknown duration.
 const clean=Buffer.from(corpus.rows.find(row=>row.packets.length>0)!.flac,'base64');
 const metadata=await openFlacDemux(source(clean),setup());const offset=Number(metadata.metadata.framesOffset);await metadata.close();
 const bytes=Buffer.concat([Buffer.alloc(5,0),clean.subarray(offset)]),opts=setup();
 const demux=await openFlacDemux(source(bytes),{...opts,maxPendingPackets:128,parserChunkBytes:1});
 expect(demux.metrics.timing.maxPendingPackets).toBe(8);
 for await(const packet of demux.packets)for await(const chunk of packet.chunks)chunk.release();
 expect(demux.metrics.timing.pendingPackets).toBe(0);expect(demux.metrics.timing.peakPendingPackets).toBe(1);
 const timing=createFlacPacketTiming({maxPendingPackets:demux.metrics.timing.maxPendingPackets});
 const junk={kind:'junk' as const,sourceOffset:0n,bytes:1n,parserDuration:0,codecPts:null,parserFrameOffset:0n,parserRawIndex:0};
 for(let i=0;i<8;i++)timing.push(junk);expect(()=>timing.push(junk)).toThrow('queue limit');timing.close();await demux.close();
});
