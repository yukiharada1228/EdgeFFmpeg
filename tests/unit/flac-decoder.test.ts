import {readFileSync} from 'node:fs';
import {beforeAll,describe,it,expect} from 'vitest';
import {createFlacDecoder} from '../../packages/avcodec/src/flac/decoder.js';
import type {FlacDecoderOptions} from '../../packages/avcodec/src/flac/decoder-types.js';
let module:WebAssembly.Module;
const corpus=JSON.parse(readFileSync('.build/flac-investigation/native-cases.json','utf8')) as {rows:{flac:string}[]};
const bytes=Buffer.from(corpus.rows[1]!.flac,'base64');
const input={size:BigInt(bytes.length),async readAt(offset:bigint,length:number){return bytes.subarray(Number(offset),Number(offset)+length);}};
function accounting(){let owned=0,releases=0;return {get owned(){return owned;},get releases(){return releases;},reserveExternalMemory(size:number){owned+=size;return()=>{owned-=size;releases++;};}};}
beforeAll(()=>{module=new WebAssembly.Module(readFileSync('.build/codecs/flac/edge-flac.wasm'));});
describe('production FLAC module lifecycle',()=>{
 it('holds borrowed planes until release and closes idempotently',async()=>{
  const account=accounting(),decoder=await createFlacDecoder(module,input,{reserveExternalMemory:account.reserveExternalMemory});
  expect(account.owned).toBe(16777216);
  let result=await decoder.next();while(result.status==='metadata')result=await decoder.next();
  expect(result.status).toBe('frame');if(result.status!=='frame')throw Error('missing frame');
  expect(result.planes[0]).toBeInstanceOf(Int32Array);await expect(decoder.next()).rejects.toThrow('unreleased');
  await decoder.close();await decoder.close();const held=result;expect(()=>held.planes).toThrow('released');
  expect(account.owned).toBe(0);expect(account.releases).toBe(1);expect(decoder.memoryBytes).toBe(0);
 });
 it('rejects concurrent next and interrupts a stalled checkpoint on close',async()=>{
  const account=accounting(),decoder=await createFlacDecoder(module,input,{reserveExternalMemory:account.reserveExternalMemory,checkpoint:()=>new Promise(()=>{})});
  const pending=decoder.next();await expect(decoder.next()).rejects.toThrow('busy');
  await decoder.close();await expect(pending).rejects.toThrow('closed');expect(account.owned).toBe(0);
 });
 it.each(['resolve','reject'] as const)('ignores late IO %s after cancellation',async action=>{
  let settle!:(bytes:Uint8Array)=>void,reject!:(error:Error)=>void,started!:()=>void;
  const entered=new Promise<void>(r=>{started=r;}),account=accounting(),abort=new AbortController();
  const decoder=await createFlacDecoder(module,{size:100n,readAt(){started();return new Promise<Uint8Array>((r,j)=>{settle=r;reject=j;});}},{reserveExternalMemory:account.reserveExternalMemory,signal:abort.signal});
  const next=decoder.next();await entered;const reason=new Error('caller abort');abort.abort(reason);
  await expect(next).rejects.toBe(reason);await decoder.close();
  if(action==='resolve')settle(new Uint8Array([1]));else reject(new Error('late failure'));
  await Promise.resolve();expect(account.owned).toBe(0);expect(account.releases).toBe(1);expect(decoder.bytesRead).toBe(0n);
 });
 it('captures checkpoint and policy before the first await',async()=>{
  const account=accounting();let calls=0;
  const options:FlacDecoderOptions={reserveExternalMemory:account.reserveExternalMemory,checkpoint:()=>{calls++;}};
  const decoder=await createFlacDecoder(module,input,options);
  Object.assign(options,{checkpoint:()=>{throw Error('mutated');},md5Checking:true,maxReadBytes:0});
  await decoder.next();expect(calls).toBe(2);await decoder.close();
 });
 it('releases on module ABI rejection and provider failure',async()=>{
  const account=accounting(),empty=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
  await expect(createFlacDecoder(empty,input,{reserveExternalMemory:account.reserveExternalMemory})).rejects.toThrow('memory');expect(account.owned).toBe(0);
  const decoder=await createFlacDecoder(module,{size:1n,async readAt(){throw Error('IO failure');}},{reserveExternalMemory:account.reserveExternalMemory});
  await expect(decoder.next()).rejects.toThrow('IO failure');expect(account.owned).toBe(0);
 });
 it('rejects signed64 input overflow before reservation',async()=>{
  const account=accounting();await expect(createFlacDecoder(module,{...input,size:1n<<63n},{reserveExternalMemory:account.reserveExternalMemory})).rejects.toThrow('input');expect(account.owned).toBe(0);
 });
});

// Minimal independently encoded ABI fixture: no generated JS glue or build tool.
function unsupportedAbiModule():WebAssembly.Module{
 const uleb=(n:number):number[]=>{const out:number[]=[];do{const byte=n&127;n>>>=7;out.push(byte|(n?128:0));}while(n);return out;};
 const vector=(items:number[][])=>[...uleb(items.length),...items.flat()];
 const name=(s:string)=>[...uleb(s.length),...new TextEncoder().encode(s)];
 const section=(id:number,data:number[])=>[id,...uleb(data.length),...data];
 const names=['edge_flac_abi','edge_flac_info_words','edge_flac_create','edge_flac_destroy','edge_flac_step','edge_flac_info','edge_flac_async_data','asyncify_start_unwind','asyncify_stop_unwind','asyncify_start_rewind','asyncify_stop_rewind'];
 return new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,
  ...section(1,vector([[0x60,0,1,0x7f]])),...section(3,vector(names.map(()=>[0]))),
  ...section(5,vector([[1,...uleb(256),...uleb(256)]])),
  ...section(7,vector([[...name('memory'),2,0],...names.map((s,i)=>[...name(s),0,...uleb(i)])])),
  ...section(10,vector(names.map(()=>[4,0,0x41,2,0x0b])))
 ]));
}
it('rejects an unsupported ABI version with exactly one reservation release',async()=>{
 const account=accounting();await expect(createFlacDecoder(unsupportedAbiModule(),input,{reserveExternalMemory:account.reserveExternalMemory})).rejects.toThrow('unsupported ABI');
 expect(account.owned).toBe(0);expect(account.releases).toBe(1);
});
it('closes an idle decoder immediately on parent abort',async()=>{
 const abort=new AbortController(),account=accounting(),decoder=await createFlacDecoder(module,input,{reserveExternalMemory:account.reserveExternalMemory,signal:abort.signal});
 abort.abort(new Error('idle cancellation'));await decoder.close();expect(account.owned).toBe(0);expect(account.releases).toBe(1);
});
it('does not copy bytes returned synchronously after provider cancellation',async()=>{
 const abort=new AbortController(),account=accounting(),reason=new Error('read cancelled');
 const decoder=await createFlacDecoder(module,{size:BigInt(bytes.length),async readAt(){abort.abort(reason);return bytes;}},{reserveExternalMemory:account.reserveExternalMemory,signal:abort.signal});
 await expect(decoder.next()).rejects.toBe(reason);expect(decoder.bytesRead).toBe(0n);expect(account.owned).toBe(0);
});
it.each([new Uint8Array(),new Uint8Array(8)])('rejects premature or excessive provider reads',async data=>{
 const account=accounting(),decoder=await createFlacDecoder(module,{size:10n,async readAt(){return data;}},{reserveExternalMemory:account.reserveExternalMemory,maxReadBytes:7});
 await expect(decoder.next()).rejects.toThrow('input read');expect(account.owned).toBe(0);
});
it('interrupts a checkpoint after Wasm execution',async()=>{
 let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});let calls=0;
 const account=accounting(),decoder=await createFlacDecoder(module,input,{reserveExternalMemory:account.reserveExternalMemory,checkpoint:()=>{if(++calls===2){entered();return new Promise(()=>{});}}});
 const pending=decoder.next();await started;await decoder.close();await expect(pending).rejects.toThrow('closed');expect(account.owned).toBe(0);
});
it('reserves resident capacity before instantiating an incompatible module',async()=>{
 const {ResourceContext}=await import('../../packages/core/src/resources.js');
 const small=new ResourceContext({maxResidentBytes:1024,maxBufferBytes:512,maxCpuTimeMs:1,maxPendingPackets:1},new AbortController().signal);
 await expect(createFlacDecoder(unsupportedAbiModule(),input,{reserveExternalMemory:n=>small.reserveExternalMemory(n)})).rejects.toThrow('Memory budget exceeded');
 expect(small.allocatedBytes).toBe(0);
 const large=new ResourceContext({maxResidentBytes:16777216,maxBufferBytes:512,maxCpuTimeMs:1,maxPendingPackets:1},new AbortController().signal);
 const decoder=await createFlacDecoder(module,input,{reserveExternalMemory:n=>large.reserveExternalMemory(n)});
 expect(large.allocatedBytes).toBe(16777216);await decoder.close();expect(large.allocatedBytes).toBe(0);
});
it('rejects unapproved function imports and releases its reservation',async()=>{
 // () => void imported as env.bad; no module start or memory is necessary.
 const bad=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,2,11,1,3,101,110,118,3,98,97,100,0,0]));
 const account=accounting();await expect(createFlacDecoder(bad,input,{reserveExternalMemory:account.reserveExternalMemory})).rejects.toThrow('unapproved Wasm import:env.bad');expect(account.owned).toBe(0);expect(account.releases).toBe(1);
});
