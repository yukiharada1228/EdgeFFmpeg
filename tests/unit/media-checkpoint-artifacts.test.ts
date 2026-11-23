import {expect,it} from 'vitest';
import type {R2Bucket} from '@cloudflare/workers-types';
import {prepareMediaCheckpoint,loadMediaCheckpoint} from '../../packages/runtime-cloudflare/src/checkpoints/artifacts.js';
const identity={jobId:'job',workUnitId:'reframe',graphHash:'a'.repeat(64),inputFingerprint:'b'.repeat(64),implementationVersion:'v1'},lease={generation:1,token:'token',expiresAt:10000};
function fixture(){
 const entries=new Map<string,{bytes:Uint8Array;version:string;etag:string;metadata:Record<string,string>}>();let sequence=0,lose=false,reads=0,writes=0;
 const bucket={async put(key:string,value:Uint8Array,options:{customMetadata:Record<string,string>}){writes++;if(entries.has(key))return null;const object={bytes:value.slice(),version:'v'+(++sequence),etag:'e'+sequence,metadata:{...options.customMetadata}};entries.set(key,object);if(lose){lose=false;throw Error('lost put acknowledgement');}return {key,version:object.version,etag:object.etag,size:object.bytes.length};},async get(key:string,options?:{onlyIf:{etagMatches:string}}){reads++;const object=entries.get(key);if(!object)return null;const base={key,version:object.version,etag:object.etag,size:object.bytes.length,customMetadata:object.metadata};if(options&&options.onlyIf.etagMatches!==object.etag)return base;return {...base,body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(object.bytes.slice());controller.close();}})};}};
 return {bucket:bucket as unknown as R2Bucket,entries,loseNext(){lose=true;},metrics:()=>({reads,writes})};
}
const input=()=>({revision:1,inputPosition:'4',outputPosition:'3',state:Uint8Array.of(1,2),output:Uint8Array.of(3,4,5),finished:false});
it('prepares immutable state/output objects and reloads exact pinned generations',async()=>{
 const run=fixture(),descriptor=await prepareMediaCheckpoint(run.bucket,identity,lease,input());expect(run.entries.size).toBe(2);expect(descriptor.state.key).toContain('/1/token/revision-1/state.bin');expect(descriptor.output!.key).toContain('/output.bin');expect(await loadMediaCheckpoint(run.bucket,descriptor)).toEqual({state:Uint8Array.of(1,2),output:Uint8Array.of(3,4,5)});expect(await prepareMediaCheckpoint(run.bucket,identity,lease,input())).toEqual(descriptor);
});
it('reconciles an object write acknowledgement loss without replacing staged data',async()=>{
 const run=fixture();run.loseNext();const descriptor=await prepareMediaCheckpoint(run.bucket,identity,lease,input());expect((await loadMediaCheckpoint(run.bucket,descriptor)).state).toEqual(Uint8Array.of(1,2));expect(run.entries.size).toBe(2);
});
it('rejects changed private bytes at a reused revision without overwriting the winner',async()=>{
 const run=fixture(),descriptor=await prepareMediaCheckpoint(run.bucket,identity,lease,input());await expect(prepareMediaCheckpoint(run.bucket,identity,lease,{...input(),state:Uint8Array.of(9,9)})).rejects.toThrow(/prepared/);expect((await loadMediaCheckpoint(run.bucket,descriptor)).state).toEqual(Uint8Array.of(1,2));
});
it('rejects changed versions and digest mismatches before returning resumed data',async()=>{
 const run=fixture(),descriptor=await prepareMediaCheckpoint(run.bucket,identity,lease,input()),stored=run.entries.get(descriptor.state.key)!;stored.version='different';await expect(loadMediaCheckpoint(run.bucket,descriptor)).rejects.toThrow(/loaded/);stored.version=descriptor.state.version;stored.bytes[0]=99;await expect(loadMediaCheckpoint(run.bucket,descriptor)).rejects.toThrow(/loaded/);
});
it('snapshots all caller bytes, identity and positions before provider awaits',async()=>{
 const run=fixture(),value=input(),expectedIdentity={...identity},activeLease={...lease},task=prepareMediaCheckpoint(run.bucket,expectedIdentity,activeLease,value);value.state[0]=99;value.output[0]=99;value.inputPosition='100';expectedIdentity.jobId='changed';activeLease.token='changed';const descriptor=await task;expect(descriptor.inputPosition).toBe('4');expect(descriptor.state.key).toContain('/token/');expect(await loadMediaCheckpoint(run.bucket,descriptor)).toEqual({state:Uint8Array.of(1,2),output:Uint8Array.of(3,4,5)});
});
it('rejects payload limits and malformed preparation before provider access',async()=>{
 const run=fixture();await expect(prepareMediaCheckpoint(run.bucket,identity,lease,input(),1)).rejects.toThrow(/limit/);await expect(prepareMediaCheckpoint(run.bucket,identity,lease,{...input(),revision:0})).rejects.toThrow(/preparation/);expect(run.metrics()).toEqual({reads:0,writes:0});const descriptor=await prepareMediaCheckpoint(run.bucket,identity,lease,input());const before=run.metrics();await expect(loadMediaCheckpoint(run.bucket,descriptor,1)).rejects.toThrow(/limit/);expect(run.metrics()).toEqual(before);
});
it('supports a state-only checkpoint without fabricating an output object',async()=>{
 const run=fixture(),descriptor=await prepareMediaCheckpoint(run.bucket,identity,lease,{...input(),output:null,outputPosition:'0'});expect(descriptor.output).toBeNull();expect(run.entries.size).toBe(1);expect((await loadMediaCheckpoint(run.bucket,descriptor)).output).toBeNull();
});
