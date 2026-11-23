import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createVorbisCommentCollector,parseVorbisCommentPayload,VorbisCommentLimitError} from '../../packages/containers/src/flac/vorbis-comment.js';
import {readVorbisCommentRange} from '../../packages/containers/src/flac/vorbis-comment-stream.js';
import type {VorbisCommentEntry} from '../../packages/containers/src/flac/comment-types.js';
const plain=JSON.parse(readFileSync('compat/behavior-specs/flac-comments/native-comments.json','utf8'));
const blocks=JSON.parse(readFileSync('compat/behavior-specs/flac-comments/native-comment-blocks.json','utf8'));
const decode=(value:string)=>Buffer.from(value,'base64');
function setup(data:Uint8Array){let owned=0;return {get owned(){return owned;},source:{size:BigInt(data.length),async readAt(offset:bigint,bytes:number){return data.subarray(Number(offset),Number(offset)+bytes);}},resources:{allocate(bytes:number){owned+=bytes;return {data:new Uint8Array(bytes),release(){owned-=bytes;}};}}};}
describe('bounded private FLAC comments',()=>{
 it('matches finite Native plain cases and verifies source hashes',()=>{
  let matched=0;
  for(const row of plain.results){expect(createHash('sha256').update(decode(row.input)).digest('hex')).toBe(row.inputSha256);const result=parseVorbisCommentPayload(decode(row.payload));if(['chapter','picture','channel-mask-valid','channel-mask-invalid'].includes(row.id)){expect(result.specialSemanticsComplete).toBe(false);continue;}expect(result.tags,row.id).toEqual(row.native.tags);matched++;}expect(matched).toBe(18);
 });
 it('matches payload semantics across 66 bounded streamed reads',async()=>{
  let executions=0;for(const row of plain.results)for(const cap of [1,7,34]){const data=decode(row.payload),state=setup(data);const {metrics,...result}=await readVorbisCommentRange(state.source,{payloadOffset:0n,payloadBytes:data.length,resources:state.resources,signal:new AbortController().signal,maxReadBytes:cap});expect(result).toEqual(parseVorbisCommentPayload(data));expect(metrics.maximumRead).toBeLessThanOrEqual(cap);expect(state.owned).toBe(0);executions++;}expect(executions).toBe(66);
 });
 it('skips a recipe-defined large vendor at bigint offsets using four scratch bytes',async()=>{
  const base=(1n<<60n)+7n,vendor=1048576,countOffset=base+4n+BigInt(vendor),header=new Uint8Array(4);new DataView(header.buffer).setUint32(0,vendor,true);const state=setup(new Uint8Array()),reads:bigint[]=[];
  const result=await readVorbisCommentRange({size:countOffset+4n,async readAt(offset:bigint,length:number){reads.push(offset);return offset===base?header:new Uint8Array(length);}},{payloadOffset:base,payloadBytes:vendor+8,maxPayloadBytes:vendor+8,resources:state.resources,signal:new AbortController().signal});expect(reads).toEqual([base,countOffset]);expect(result.metrics.bytesRead).toBe(8);expect(result.metrics.peakOwnedBufferBytes).toBe(4);expect(state.owned).toBe(0);
 });
 it('preserves ordered Native multi-block canonical collisions',async()=>{
  for(const row of blocks.rows){expect(createHash('sha256').update(decode(row.input)).digest('hex')).toBe(row.inputSha256);let entries:readonly VorbisCommentEntry[]=[];for(const payload of row.payloads){const state=setup(decode(payload));const result=await readVorbisCommentRange(state.source,{payloadOffset:0n,payloadBytes:state.source.size===0n?0:Number(state.source.size),resources:state.resources,signal:new AbortController().signal,initialEntries:entries,maxReadBytes:2});entries=result.tagEntries;expect(state.owned).toBe(0);expect(result.metrics.closed).toBe(true);}expect(entries,row.id).toEqual(row.native.tagEntries);}
 });
 it('enforces entry, decoded string, state, payload and read budgets',async()=>{
  const data=decode(plain.results.find((r:{id:string})=>r.id==='basic').payload);
  for(const options of [{maxPayloadBytes:1},{maxEntries:1},{maxDecodedBytes:1}])expect(()=>parseVorbisCommentPayload(data,options)).toThrow(VorbisCommentLimitError);
  const c=createVorbisCommentCollector({maxStateChars:2});expect(()=>c.accept(new TextEncoder().encode('A=long'))).toThrow(VorbisCommentLimitError);
  const state=setup(data);await expect(readVorbisCommentRange(state.source,{payloadOffset:0n,payloadBytes:data.length,resources:state.resources,signal:new AbortController().signal,maxEntryBytes:1})).rejects.toThrow(VorbisCommentLimitError);expect(state.owned).toBe(0);
 });
 it('skips vendor bytes and retains invalid UTF8 ranges without byte ownership',async()=>{
  const data=Uint8Array.of(2,0,0,0,255,255,1,0,0,0,3,0,0,0,65,61,255),state=setup(data);
  const result=await readVorbisCommentRange(state.source,{payloadOffset:0n,payloadBytes:data.length,resources:state.resources,signal:new AbortController().signal});expect(result.deferred).toEqual([{kind:'invalid-utf8',sourceRange:{offset:14n,bytes:3n}}]);expect(result.metrics.bytesRead).toBe(15);expect(state.owned).toBe(0);
 });
 it('interrupts checkpoints and reads and observes late settlement',async()=>{
  for(const checkpointWait of [false,true]){const state=setup(new Uint8Array(8)),controller=new AbortController();let settle!:(bytes:Uint8Array)=>void;let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const pending=new Promise<Uint8Array>(resolve=>{settle=resolve;});const options={payloadOffset:0n,payloadBytes:8,resources:state.resources,signal:controller.signal,...(checkpointWait?{checkpoint:()=>{entered();return pending.then(()=>{});}}:{})};
   const source=checkpointWait?state.source:{size:8n,readAt(){entered();return pending;}};const result=readVorbisCommentRange(source,options);await ready;controller.abort(new Error('cancel'));await expect(result).rejects.toThrow('cancel');expect(state.owned).toBe(0);settle(new Uint8Array(4));await Promise.resolve();expect(state.owned).toBe(0);
  }
 });
 it('uses structural chapters hook and leaves other effects explicit',()=>{const c=createVorbisCommentCollector({chapterState:{accept:(key)=>key==='CHAPTER001'}});c.accept(new TextEncoder().encode('CHAPTER001=00:00:01.000'));c.accept(new TextEncoder().encode('METADATA_BLOCK_PICTURE=x'));expect(c.snapshot().deferred).toEqual([{kind:'picture',key:'METADATA_BLOCK_PICTURE',value:'x'}]);});
});
