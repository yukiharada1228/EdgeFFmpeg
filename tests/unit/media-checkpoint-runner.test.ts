import {expect,it,vi} from 'vitest';
import type {R2Bucket} from '@cloudflare/workers-types';
import type {VirtualFileSystem} from '../../packages/core/src/index.js';
import type {StoredMediaCheckpoint} from '../../packages/runtime-cloudflare/src/checkpoints/state.js';
import type {MediaCheckpointDescriptor,MediaCheckpointLease} from '../../packages/runtime-cloudflare/src/checkpoints/types.js';
import {cancelMediaCheckpoint,claimMediaCheckpoint,commitMediaCheckpoint,expireMediaCheckpoint,heartbeatMediaCheckpoint,initializeMediaCheckpoint,mediaCheckpointCoordinatorName,validMediaCheckpointLease} from '../../packages/runtime-cloudflare/src/checkpoints/state.js';
import {preflightCheckpointedMediaUnit,runCheckpointedMediaUnit} from '../../packages/runtime-cloudflare/src/checkpoints/runner.js';
import {MediaCheckpointOutputConflictError} from '../../packages/runtime-cloudflare/src/checkpoints/output.js';
import type {MediaCheckpointComponent,MediaCheckpointJournal,RunCheckpointedMediaUnitOptions} from '../../packages/runtime-cloudflare/src/checkpoints/runner.js';
const identity={jobId:'runner',workUnitId:'fifo',graphHash:'a'.repeat(64),inputFingerprint:'b'.repeat(64),implementationVersion:'v1'},input=Uint8Array.from({length:10},(_,index)=>index+1);
function bucket(){
 const entries=new Map<string,{bytes:Uint8Array;version:string;etag:string;metadata:Record<string,string>}>();let sequence=0;
 const provider={async put(key:string,value:Uint8Array,options:{customMetadata:Record<string,string>}){if(entries.has(key))return null;const object={bytes:value.slice(),version:'v'+(++sequence),etag:'e'+sequence,metadata:{...options.customMetadata}};entries.set(key,object);return {key,version:object.version,etag:object.etag,size:object.bytes.length};},async get(key:string,options?:{onlyIf:{etagMatches:string}}){const object=entries.get(key);if(!object)return null;const base={key,version:object.version,etag:object.etag,size:object.bytes.length,customMetadata:object.metadata};if(options&&options.onlyIf.etagMatches!==object.etag)return base;return {...base,body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(object.bytes.slice());controller.close();}})};}};
 return {bucket:provider as unknown as R2Bucket,entries};
}
// Mirrors the Durable Object transitions; structuredClone stands in for RPC copies.
async function coordinator(){
 const name=await mediaCheckpointCoordinatorName(identity);let stored:StoredMediaCheckpoint|null=null,now=1000,token=0;const calls:string[]=[],faults={lostAcks:0,failCommits:0,failStatus:0,onCommit:undefined as (()=>void)|undefined};
 const clone=<T>(value:T):T=>structuredClone(value);
 const journal:MediaCheckpointJournal={
  async initialize(value){calls.push('initialize');stored=initializeMediaCheckpoint(stored,value,name);return clone(stored.status);},
  async claim(leaseMs){calls.push('claim');const result=claimMediaCheckpoint(stored!,leaseMs,now,'attempt'+(++token));stored=result.journal;return clone(result.claim);},
  async heartbeat(lease){calls.push('heartbeat');const result=heartbeatMediaCheckpoint(stored!,lease,now);stored=result.journal;return clone(result.lease);},
  async status(){calls.push('status');if(faults.failStatus>0){faults.failStatus--;throw Error('status unavailable');}stored=expireMediaCheckpoint(stored!,now);return clone(stored.status);},
  async commit(lease,descriptor){calls.push('commit');faults.onCommit?.();if(faults.failCommits>0){faults.failCommits--;throw Error('commit transport failure');}stored=commitMediaCheckpoint(stored!,lease,descriptor,now);if(faults.lostAcks>0){faults.lostAcks--;throw Error('lost commit acknowledgement');}return clone(stored.status);},
 };
 return {journal,calls,faults,get stored(){return stored!;},advance(ms:number){now+=ms;},valid:(lease:MediaCheckpointLease)=>validMediaCheckpointLease(stored!,lease,now),cancel(){stored=cancelMediaCheckpoint(stored!);},steal(){stored=claimMediaCheckpoint(expireMediaCheckpoint(stored!,now+1000000),1000,now,'thief').journal;}};
}
interface Counter {received:number;emitted:number;disposed:boolean}
function component(unit=3){
 const live:Counter[]=[],events:string[]=[];
 const value:MediaCheckpointComponent<Counter>={
  create(){events.push('create');const state={received:0,emitted:0,disposed:false};live.push(state);return state;},
  restore(bytes,position){events.push('restore:'+position.revision);const parsed=JSON.parse(new TextDecoder().decode(bytes)) as {received:number;emitted:number};const state={...parsed,disposed:false};live.push(state);return state;},
  process(state,position){events.push('process:'+position.inputPosition);const start=Number(position.inputPosition),end=Math.min(input.length,start+unit),output=input.subarray(start,end);state.received=end;state.emitted+=output.length;return {output:output.length?output:null,inputPosition:String(end),finished:end===input.length};},
  serialize:state=>new TextEncoder().encode(JSON.stringify({received:state.received,emitted:state.emitted})),
  verify:(state,position)=>String(state.received)===position.inputPosition&&String(state.emitted)===position.outputPosition,
  dispose(state){events.push('dispose');state.disposed=true;},
 };
 return {value,live,events};
}
function filesystem(){
 const writes:Uint8Array[]=[],published=new Map<string,Uint8Array>(),openWrite=vi.fn(async(path:string)=>({async write(bytes:Uint8Array){writes.push(bytes.slice());},async commit(){published.set(path,Uint8Array.from(writes.flatMap(bytes=>[...bytes])));},async abort(){writes.length=0;}}));
 // Only a published destination is readable: finalize verifies it on replay.
 const openRead=vi.fn(async(path:string)=>{const bytes=published.get(path);if(!bytes)throw Error('Unexpected input read');return {size:BigInt(bytes.length),readAt:async(offset:bigint,length:number)=>bytes.slice(Number(offset),Number(offset)+length)};});
 const files:VirtualFileSystem={openRead,openWrite,outputExists:async path=>published.has(path)};return {files,published,openWrite,openRead};
}
async function setup(unit=3){const storage=bucket(),journal=await coordinator(),adapter=component(unit),output=filesystem();const options=(extra:Partial<RunCheckpointedMediaUnitOptions<Counter>>={}):RunCheckpointedMediaUnitOptions<Counter>=>({bucket:storage.bucket,journal:journal.journal,identity,component:adapter.value,leaseMs:1000,maxUnits:2,finalize:{filesystem:output.files,path:'/final.bin'},...extra});return {storage,journal,adapter,output,options};}
it('yields at the unit budget, resumes from the committed head in a later invocation and finalizes once',async()=>{
 const run=await setup(),first=await runCheckpointedMediaUnit(run.options());expect(first).toMatchObject({outcome:'yielded',units:2,commitRetries:0,finalized:null,conflict:null});expect(first.status).toMatchObject({phase:'running',revision:2,inputPosition:'6',outputPosition:'6'});expect(run.adapter.events).toEqual(['create','process:0','process:3','dispose']);
 // Invocation ended with a live lease; a new one waits for expiry, then restores.
 expect(await runCheckpointedMediaUnit(run.options())).toMatchObject({outcome:'busy',units:0});expect(run.adapter.events).toHaveLength(4);run.journal.advance(1001);run.adapter.events.length=0;
 const second=await runCheckpointedMediaUnit(run.options());expect(second.outcome).toBe('finished');expect(second.units).toBe(2);expect(second.finalized).toEqual({bytes:10n,revisions:4,outputChunks:4});expect(run.adapter.events).toEqual(['restore:2','process:6','process:9','dispose']);
 expect([...run.output.published.get('/final.bin')!]).toEqual([...input]);expect(run.journal.stored.status).toMatchObject({phase:'finished',revision:4,lease:null});expect(run.adapter.live.every(state=>state.disposed)).toBe(true);
 // Replay after publication neither claims nor reopens a writer; it verifies the published bytes.
 run.journal.calls.length=0;const replay=await runCheckpointedMediaUnit(run.options());expect(replay).toMatchObject({outcome:'finished',units:0,conflict:null});expect(replay.finalized).toEqual({bytes:10n,revisions:4,outputChunks:4,existing:true});expect(run.journal.calls).toEqual(['initialize']);expect(run.output.openWrite).toHaveBeenCalledOnce();expect(run.output.openRead).toHaveBeenCalledOnce();
});
it('reports a differing no-clobber destination as output-conflict with the finished status and never overwrites it',async()=>{
 const run=await setup(),foreign=Uint8Array.of(9,9,9);run.output.published.set('/final.bin',foreign);
 const result=await runCheckpointedMediaUnit(run.options({maxUnits:8}));expect(result).toMatchObject({outcome:'output-conflict',units:4,finalized:null});expect(result.status).toMatchObject({phase:'finished',revision:4});
 expect(result.conflict).toBeInstanceOf(MediaCheckpointOutputConflictError);expect(result.conflict).toMatchObject({path:'/final.bin',expected:{bytes:10n},actual:{bytes:3n}});expect(run.output.openWrite).not.toHaveBeenCalled();expect(run.output.published.get('/final.bin')).toBe(foreign);
 // Same size, different bytes: the streamed SHA-256 decides; a replay stays a conflict and claims nothing.
 run.output.published.set('/final.bin',input.map(byte=>byte^1));run.journal.calls.length=0;const replay=await runCheckpointedMediaUnit(run.options());expect(replay.outcome).toBe('output-conflict');expect(replay.conflict!.actual.bytes).toBe(10n);expect(replay.conflict!.actual.sha256).not.toBe(replay.conflict!.expected.sha256);expect(run.journal.calls).toEqual(['initialize']);
 // Identical bytes published by someone else verify as existing.
 run.output.published.set('/final.bin',input.slice());expect(await runCheckpointedMediaUnit(run.options())).toMatchObject({outcome:'finished',finalized:{bytes:10n,existing:true}});
});
it('rethrows other finalize failures and reports abort before finalization without opening a writer',async()=>{
 const run=await setup();run.output.openWrite.mockRejectedValueOnce(Error('destination unavailable'));await expect(runCheckpointedMediaUnit(run.options({maxUnits:8}))).rejects.toThrow(/destination unavailable/);expect(run.journal.stored.status.phase).toBe('finished');
 const controller=new AbortController(),commit=run.journal.journal.commit;run.journal.calls.length=0;
 const aborted=await runCheckpointedMediaUnit(run.options({signal:controller.signal,journal:{...run.journal.journal,async initialize(value){const status=await run.journal.journal.initialize(value);controller.abort();return status;},commit}}));
 expect(aborted).toMatchObject({outcome:'aborted',finalized:null});expect(aborted.status!.phase).toBe('finished');expect(run.output.openWrite).toHaveBeenCalledOnce();
 expect(await runCheckpointedMediaUnit(run.options())).toMatchObject({outcome:'finished',finalized:{bytes:10n,revisions:4,outputChunks:4}});expect([...run.output.published.get('/final.bin')!]).toEqual([...input]);
});
it('continues a yielded lease without waiting for its expiry and falls back to claim once it is gone',async()=>{
 const run=await setup(),first=await runCheckpointedMediaUnit(run.options({maxUnits:1})),held=first.status!.lease!;expect(first.outcome).toBe('yielded');
 // Without the lease a new invocation only sees an active owner.
 expect(await runCheckpointedMediaUnit(run.options({maxUnits:1}))).toMatchObject({outcome:'busy',units:0});
 run.journal.calls.length=0;run.journal.advance(500);const second=await runCheckpointedMediaUnit(run.options({maxUnits:1,resumeLease:held}));expect(second).toMatchObject({outcome:'yielded',units:1});expect(run.journal.calls.slice(0,4)).toEqual(['initialize','heartbeat','status','heartbeat']);expect(run.journal.calls).not.toContain('claim');
 expect(second.status!.lease).toMatchObject({generation:held.generation,token:held.token});expect(second.status!.lease!.expiresAt).toBeGreaterThan(held.expiresAt);expect(run.adapter.events.filter(event=>event.startsWith('restore'))).toEqual(['restore:1']);
 // Expired: the stale lease is refused by heartbeat and a fresh generation is claimed.
 run.journal.advance(1001);const third=await runCheckpointedMediaUnit(run.options({maxUnits:1,resumeLease:second.status!.lease!}));expect(third.outcome).toBe('yielded');expect(third.status!.lease!.generation).toBe(held.generation+1);
 // Stolen: heartbeat refuses the old token and the thief's live lease makes the run busy.
 run.journal.advance(1001);run.journal.steal();expect(await runCheckpointedMediaUnit(run.options({maxUnits:1,resumeLease:third.status!.lease!}))).toMatchObject({outcome:'busy',units:0});
 // Cancelled after a yield: the fenced journal is reported, never resumed.
 const fenced=await setup(),yielded=await runCheckpointedMediaUnit(fenced.options({maxUnits:1}));fenced.journal.cancel();expect(await runCheckpointedMediaUnit(fenced.options({resumeLease:yielded.status!.lease!}))).toMatchObject({outcome:'cancelled',units:0});expect(fenced.journal.stored.status.revision).toBe(1);
 // Finish through a resumed lease commits every remaining revision under that one owner.
 const chained=await setup();let lease=(await runCheckpointedMediaUnit(chained.options({maxUnits:1}))).status!.lease!;for(let index=0;index<2;index++)lease=(await runCheckpointedMediaUnit(chained.options({maxUnits:1,resumeLease:lease}))).status!.lease!;
 expect(await runCheckpointedMediaUnit(chained.options({maxUnits:1,resumeLease:lease}))).toMatchObject({outcome:'finished',finalized:{bytes:10n,revisions:4}});expect(new Set(chained.journal.stored.committers.map(owner=>owner.token)).size).toBe(1);expect(chained.journal.calls.filter(call=>call==='claim')).toHaveLength(1);
});
it('renews the lease before every unit and commits strictly in revision order',async()=>{
 const run=await setup(4);await runCheckpointedMediaUnit(run.options({maxUnits:8}));expect(run.journal.calls).toEqual(['initialize','claim','heartbeat','commit','heartbeat','commit','heartbeat','commit']);expect(run.journal.stored.status.commits.map(commit=>[commit.revision,commit.inputPosition,commit.outputPosition,commit.finished])).toEqual([[1,'4','4',false],[2,'8','8',false],[3,'10','10',true]]);
});
it('retries the identical descriptor after a lost commit acknowledgement without duplicating revisions',async()=>{
 const run=await setup(),seen:MediaCheckpointDescriptor[]=[],commit=run.journal.journal.commit.bind(run.journal.journal);run.journal.journal.commit=async(lease,descriptor)=>{seen.push(structuredClone(descriptor));return commit(lease,descriptor);};run.journal.faults.lostAcks=1;
 const result=await runCheckpointedMediaUnit(run.options({maxUnits:1}));expect(result).toMatchObject({outcome:'yielded',units:1,commitRetries:1});expect(seen).toHaveLength(2);expect(seen[1]).toEqual(seen[0]);expect(run.journal.stored.status.commits).toHaveLength(1);expect(run.journal.stored.committers).toHaveLength(1);
});
it('confirms a commit from the journal when replies keep failing',async()=>{
 const run=await setup();run.journal.faults.lostAcks=3;const result=await runCheckpointedMediaUnit(run.options({maxUnits:1}));expect(result).toMatchObject({outcome:'yielded',units:1});expect(run.journal.calls.filter(call=>call==='commit')).toHaveLength(2);expect(run.journal.calls.at(-1)).toBe('status');expect(run.journal.stored.status.revision).toBe(1);
});
it('throws an unconfirmed commit and lets a later owner recompute from the last committed state',async()=>{
 const run=await setup();run.journal.faults.failCommits=3;await expect(runCheckpointedMediaUnit(run.options({maxUnits:1,maxCommitAttempts:3}))).rejects.toThrow(/commit transport failure/);expect(run.journal.stored.status.revision).toBe(0);expect(run.adapter.live.every(state=>state.disposed)).toBe(true);
 const orphaned=run.storage.entries.size;expect(orphaned).toBe(2);run.journal.advance(1001);const resumed=await runCheckpointedMediaUnit(run.options({maxUnits:8}));expect(resumed.outcome).toBe('finished');expect(run.storage.entries.size).toBe(orphaned+8);expect([...run.output.published.get('/final.bin')!]).toEqual([...input]);
});
it('aggregates a commit failure with a failed journal inspection',async()=>{
 const run=await setup();run.journal.faults.failCommits=2;run.journal.faults.failStatus=1;const failure=await runCheckpointedMediaUnit(run.options({maxUnits:1,maxCommitAttempts:2})).catch((error:unknown)=>error);expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors.map(error=>(error as Error).message)).toEqual(['commit transport failure','status unavailable']);
});
it('stops cleanly when the journal is cancelled during a unit',async()=>{
 const run=await setup(),process=run.adapter.value.process;run.adapter.value.process=(state,position,signal)=>{run.journal.cancel();return process(state,position,signal);};
 const result=await runCheckpointedMediaUnit(run.options());expect(result).toMatchObject({outcome:'cancelled',units:0});expect(result.status!.phase).toBe('cancelled');expect(run.journal.stored.status.revision).toBe(0);expect(run.adapter.events.at(-1)).toBe('dispose');
 run.adapter.events.length=0;run.journal.calls.length=0;expect(await runCheckpointedMediaUnit(run.options())).toMatchObject({outcome:'cancelled'});expect(run.journal.calls).toEqual(['initialize']);expect(run.adapter.events).toEqual([]);
});
it('stops at heartbeat after cancellation between units',async()=>{
 const run=await setup(),commit=run.journal.journal.commit.bind(run.journal.journal);run.journal.journal.commit=async(lease,descriptor)=>{const status=await commit(lease,descriptor);run.journal.cancel();return status;};
 expect(await runCheckpointedMediaUnit(run.options({maxUnits:4}))).toMatchObject({outcome:'cancelled',units:1});expect(run.journal.calls.slice(-2)).toEqual(['heartbeat','status']);
});
it('reports lease loss to a newer owner and never commits stale work',async()=>{
 const run=await setup(),process=run.adapter.value.process;let lease:MediaCheckpointLease|null=null;run.adapter.value.process=(state,position,signal)=>{lease=run.journal.stored.status.lease;run.journal.steal();return process(state,position,signal);};
 const result=await runCheckpointedMediaUnit(run.options());expect(result.outcome).toBe('lease-lost');expect(run.journal.valid(lease!)).toBe(false);expect(run.journal.stored.status.revision).toBe(0);expect(run.journal.stored.status.lease!.token).toBe('thief');
 const heartbeat=await setup();await runCheckpointedMediaUnit(heartbeat.options({maxUnits:1}));const recover=heartbeat.journal.journal.heartbeat.bind(heartbeat.journal.journal);heartbeat.journal.advance(1001);heartbeat.journal.journal.heartbeat=async lease=>{heartbeat.journal.steal();return recover(lease);};
 expect(await runCheckpointedMediaUnit(heartbeat.options())).toMatchObject({outcome:'lease-lost',units:0});expect(heartbeat.journal.stored.status.revision).toBe(1);
 // A heartbeat refused because another owner finished the journal finalizes (verifies) instead of reporting lease loss.
 const overtaken=await setup(),first=overtaken.journal.journal,finishOther=async()=>{overtaken.journal.advance(1001);await runCheckpointedMediaUnit(overtaken.options({maxUnits:8}));};
 let raced=false;const racing:MediaCheckpointJournal={...first,heartbeat:async lease=>{if(!raced&&overtaken.journal.stored.status.revision===1){raced=true;await finishOther();}return first.heartbeat(lease);}};
 const late=await runCheckpointedMediaUnit(overtaken.options({maxUnits:8,journal:racing}));expect(late).toMatchObject({outcome:'finished',units:1,finalized:{bytes:10n,revisions:4,existing:true}});expect(late.status).toMatchObject({phase:'finished',revision:4});
 expect(overtaken.output.openWrite).toHaveBeenCalledOnce();expect(new Set(overtaken.journal.stored.committers.map(owner=>owner.token)).size).toBe(2);
});
it('observes abort signals at unit boundaries and during processing without committing',async()=>{
 const run=await setup(),controller=new AbortController();controller.abort();expect(await runCheckpointedMediaUnit(run.options({signal:controller.signal}))).toMatchObject({outcome:'aborted',status:null});expect(run.journal.calls).toEqual([]);
 const during=new AbortController();run.adapter.value.process=(_state,_position,signal)=>{during.abort(Error('stop'));signal!.throwIfAborted();throw Error('unreachable');};const result=await runCheckpointedMediaUnit(run.options({signal:during.signal}));expect(result).toMatchObject({outcome:'aborted',units:0});expect(run.journal.calls).not.toContain('commit');expect(run.storage.entries.size).toBe(0);expect(run.adapter.events.at(-1)).toBe('dispose');
});
it('rejects restored counters that disagree with the journal head and tampered committed state',async()=>{
 const run=await setup();await runCheckpointedMediaUnit(run.options({maxUnits:1}));run.journal.advance(1001);run.journal.calls.length=0;const verify=run.adapter.value.verify;run.adapter.value.verify=()=>false;
 const restored=await runCheckpointedMediaUnit(run.options()).catch((error:unknown)=>error);expect(restored).toBeInstanceOf(TypeError);expect((restored as Error).message).toMatch(/counters disagree with journal positions/);expect(run.journal.calls).not.toContain('commit');expect(run.adapter.events.at(-1)).toBe('dispose');run.adapter.value.verify=verify;
 run.journal.advance(1001);run.storage.entries.get(run.journal.stored.status.commits[0]!.state.key)!.bytes[0]=0x20;run.adapter.events.length=0;await expect(runCheckpointedMediaUnit(run.options())).rejects.toThrow(/could not be loaded/);expect(run.adapter.events).toEqual([]);expect(run.journal.stored.status.revision).toBe(1);
});
it('rejects units whose counters or positions do not advance consistently',async()=>{
 // Component contract violations are TypeErrors, so schedulers can treat them as deterministic.
 const contract=async(value:Promise<unknown>,pattern:RegExp)=>{const error=await value.catch((failure:unknown)=>failure);expect(error).toBeInstanceOf(TypeError);expect((error as Error).message).toMatch(pattern);};
 const stuck=await setup();stuck.adapter.value.process=()=>({output:null,inputPosition:'0',finished:false});await contract(runCheckpointedMediaUnit(stuck.options()),/advance monotonically/);
 const drift=await setup();const process=drift.adapter.value.process;drift.adapter.value.process=async(state,position,signal)=>{const unit=await process(state,position,signal);state.emitted++;return unit;};await contract(runCheckpointedMediaUnit(drift.options()),/unit positions/);expect(drift.storage.entries.size).toBe(0);
 const malformed=await setup();malformed.adapter.value.process=()=>({output:null,inputPosition:'01',finished:false});await expect(runCheckpointedMediaUnit(malformed.options())).rejects.toThrow(/Invalid checkpoint unit result/);
 const oversized=await setup();await expect(runCheckpointedMediaUnit(oversized.options({maxObjectBytes:2,finalize:{filesystem:oversized.output.files,path:'/final.bin',maxWriteBytes:1}}))).rejects.toThrow(/object byte limit/);expect(oversized.journal.stored.status.revision).toBe(0);
});
it('treats empty output as a null pointer and empty EOF as a terminal commit',async()=>{
 const run=await setup(10),process=run.adapter.value.process;let calls=0;run.adapter.value.process=async(state,position,signal)=>{const unit=await process(state,position,signal);return calls++===0?{...unit,finished:false}:{output:new Uint8Array(0),inputPosition:position.inputPosition,finished:true};};
 const result=await runCheckpointedMediaUnit(run.options({maxUnits:4}));expect(result.outcome).toBe('finished');expect(run.journal.stored.status.commits.map(commit=>commit.output===null)).toEqual([false,true]);expect(result.finalized).toEqual({bytes:10n,revisions:2,outputChunks:1});
});
it('validates limits and adapters before touching the journal',async()=>{
 const run=await setup();for(const extra of [{leaseMs:9},{maxUnits:0},{maxUnits:257},{maxCommitAttempts:9},{maxObjectBytes:0}])await expect(runCheckpointedMediaUnit(run.options(extra))).rejects.toThrow(RangeError);
 await expect(runCheckpointedMediaUnit(run.options({component:{...run.adapter.value,verify:undefined} as unknown as MediaCheckpointComponent<Counter>}))).rejects.toThrow(TypeError);await expect(runCheckpointedMediaUnit(run.options({identity:{...identity,graphHash:'x'}}))).rejects.toThrow();
 for(const lease of [{generation:0,token:'a',expiresAt:1},{generation:1,token:'a/b',expiresAt:1},{generation:1,token:'a',expiresAt:0},null])await expect(runCheckpointedMediaUnit(run.options({resumeLease:lease as unknown as MediaCheckpointLease}))).rejects.toThrow(TypeError);expect(run.journal.calls).toEqual([]);
});
it('preflights every finalize option before any unit runs or commits',async()=>{
 const run=await setup(),files=run.output.files,finalize={filesystem:files,path:'/final.bin'};
 type Finalize=NonNullable<RunCheckpointedMediaUnitOptions<Counter>['finalize']>;
 const typed:Record<string,unknown>[]=[{path:'final.bin'},{path:'/'},{path:'/a//b'},{path:'/a/../b'},{path:'/a/./b'},{path:'/a\\b'},{path:'/a\0b'},{filesystem:{...files,openWrite:undefined} as unknown as VirtualFileSystem},{filesystem:{...files,openRead:undefined} as unknown as VirtualFileSystem},{filesystem:{...files,outputExists:true} as unknown as VirtualFileSystem},{filesystem:undefined as unknown as VirtualFileSystem},{overwrite:'yes' as unknown as boolean},{patches:{}}];
 for(const extra of typed)await expect(runCheckpointedMediaUnit(run.options({finalize:{...finalize,...extra} as Finalize}))).rejects.toThrow(TypeError);
 await expect(runCheckpointedMediaUnit(run.options({finalize:null as unknown as Finalize}))).rejects.toThrow(TypeError);
 // maxWriteBytes defaults to 64 KiB, so a smaller object limit needs an explicit write limit (finalize's own rule).
 for(const [extra,objects] of [[{},1024],[{maxWriteBytes:2048},1024],[{maxWriteBytes:0},1024],[{maxWriteBytes:512,maxReadBytes:2048},1024],[{maxReadBytes:0},8388608],[{maxPatches:0},8388608],[{maxPatches:257},8388608],[{maxPatchBytes:0},8388608],[{maxPatchBytes:65537},8388608],[{maxWriteBytes:1.5},8388608]] as const)
  await expect(runCheckpointedMediaUnit(run.options({maxObjectBytes:objects,finalize:{...finalize,...extra}}))).rejects.toThrow(RangeError);
 expect(run.journal.calls).toEqual([]);expect(run.adapter.events).toEqual([]);expect(run.storage.entries.size).toBe(0);
 // Mutating the caller's object after the call cannot bypass the snapshot.
 const options=run.options({maxUnits:8,finalize:{...finalize,maxWriteBytes:4}}),pending=runCheckpointedMediaUnit(options);(options.finalize as {maxWriteBytes:number}).maxWriteBytes=1e9;expect((await pending).outcome).toBe('finished');
 expect(()=>preflightCheckpointedMediaUnit(run.options({finalize:{...finalize,path:'/x/'}}))).toThrow(TypeError);expect(()=>preflightCheckpointedMediaUnit(run.options({identity:{...identity,inputFingerprint:'z'}}))).toThrow();expect(()=>preflightCheckpointedMediaUnit(run.options({maxObjectBytes:1024,finalize:{...finalize,maxWriteBytes:1024,maxReadBytes:1024}}))).not.toThrow();
});
