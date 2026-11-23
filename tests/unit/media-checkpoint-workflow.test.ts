import {createHash} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import type {DurableObjectId,R2Bucket} from '@cloudflare/workers-types';
import type {VirtualFileSystem} from '../../packages/core/src/index.js';
import type {StoredMediaCheckpoint} from '../../packages/runtime-cloudflare/src/checkpoints/state.js';
import type {MediaCheckpointStatus} from '../../packages/runtime-cloudflare/src/checkpoints/types.js';
import {cancelMediaCheckpoint,claimMediaCheckpoint,commitMediaCheckpoint,expireMediaCheckpoint,heartbeatMediaCheckpoint,initializeMediaCheckpoint,mediaCheckpointCoordinatorName} from '../../packages/runtime-cloudflare/src/checkpoints/state.js';
import type {MediaCheckpointComponent,MediaCheckpointJournal} from '../../packages/runtime-cloudflare/src/checkpoints/runner.js';
import type {MediaCheckpointWorkflowSpec} from '../../packages/runtime-cloudflare/src/checkpoints/workflow-spec.js';
import {buildMediaCheckpointWorkflowSpec,hashMediaCheckpointWorkflowSpec,mediaCheckpointWorkflowGraphHash,verifyMediaCheckpointWorkflowSpec} from '../../packages/runtime-cloudflare/src/checkpoints/workflow-spec.js';
import type {MediaCheckpointComponentRegistry,MediaCheckpointWorkflowStep} from '../../packages/runtime-cloudflare/src/checkpoints/workflow-run.js';
import {MediaCheckpointWorkflowError,retryableMediaCheckpointWorkflowError,runMediaCheckpointWorkflow} from '../../packages/runtime-cloudflare/src/checkpoints/workflow-run.js';
import {publishMediaCheckpointWorkflowResult} from '../../packages/runtime-cloudflare/src/checkpoints/workflow-result.js';
import {MediaCheckpointOutputConflictError} from '../../packages/runtime-cloudflare/src/checkpoints/output.js';
import {cancelMediaCheckpointWorkflow,MediaCheckpointWorkflowCancellationError} from '../../packages/runtime-cloudflare/src/checkpoints/workflow-control.js';
const input=Uint8Array.from({length:10},(_,index)=>index+1),start=1_800_000_000_000,inputSha256=createHash('sha256').update(input).digest('hex');
// Workers' streaming SHA-256 (crypto.DigestStream), which destination digests use, does not exist in Node.
class DigestStream extends WritableStream<Uint8Array>{
 readonly digest:Promise<ArrayBuffer>;
 constructor(algorithm:string){const hash=createHash('sha256');let done:(value:ArrayBuffer)=>void=()=>{};const digest=new Promise<ArrayBuffer>(resolve=>{done=resolve;});super({write(chunk){hash.update(chunk);},close(){done(new Uint8Array(hash.digest()).buffer);}});if(algorithm!=='SHA-256')throw TypeError('Unsupported digest');this.digest=digest;}
}
beforeAll(()=>{Object.defineProperty(crypto,'DigestStream',{value:DigestStream,configurable:true});});
afterAll(()=>{Reflect.deleteProperty(crypto,'DigestStream');});
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(start);});
afterEach(()=>{vi.useRealTimers();});
const advance=(ms:number)=>vi.setSystemTime(Date.now()+ms);
function bucket(){
 const entries=new Map<string,{bytes:Uint8Array;version:string;etag:string;metadata:Record<string,string>}>(),faults={lostPut:0};let sequence=0;
 const base=(key:string)=>{const object=entries.get(key)!;return {key,version:object.version,etag:object.etag,size:object.bytes.length,customMetadata:object.metadata};};
 const provider={
  head:vi.fn(async(key:string)=>entries.has(key)?base(key):null),
  async put(key:string,value:Uint8Array,options?:{onlyIf?:{etagDoesNotMatch?:string};customMetadata?:Record<string,string>}){if(options?.onlyIf&&entries.has(key))return null;const object={bytes:value.slice(),version:'v'+(++sequence),etag:'e'+sequence,metadata:{...options?.customMetadata}};entries.set(key,object);if(faults.lostPut>0){faults.lostPut--;throw Error('lost put acknowledgement');}return base(key);},
  async get(key:string,options?:{onlyIf:{etagMatches:string}}){const object=entries.get(key);if(!object)return null;if(options&&options.onlyIf.etagMatches!==object.etag)return base(key);return {...base(key),arrayBuffer:async()=>object.bytes.slice().buffer,body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(object.bytes.slice());controller.close();}})};},
 };
 return {bucket:provider as unknown as R2Bucket,entries,faults,head:provider.head};
}
// Pure coordinator transitions behind a structured-clone boundary, keyed by journal name like the DO namespace.
function coordinators(){
 const journals=new Map<string,StoredMediaCheckpoint|null>(),calls:string[]=[];let token=0;
 const clone=<T>(value:T):T=>structuredClone(value);
 const stub=(name:string)=>{
  const read=()=>journals.get(name)??null,write=(value:StoredMediaCheckpoint)=>{journals.set(name,value);};
  return {
   async initialize(value:MediaCheckpointStatus['identity']){calls.push('initialize');const journal=initializeMediaCheckpoint(read(),value,await mediaCheckpointCoordinatorName(value));write(journal);return clone(journal.status);},
   async claim(leaseMs:number){calls.push('claim');const result=claimMediaCheckpoint(read()!,leaseMs,Date.now(),'owner'+(++token));write(result.journal);return clone(result.claim);},
   async heartbeat(lease:Parameters<MediaCheckpointJournal['heartbeat']>[0]){calls.push('heartbeat');const result=heartbeatMediaCheckpoint(read()!,lease,Date.now());write(result.journal);return clone(result.lease);},
   async status(){calls.push('status');const journal=read();if(!journal)return null;const expired=expireMediaCheckpoint(journal,Date.now());write(expired);return clone(expired.status);},
   async commit(lease:Parameters<MediaCheckpointJournal['commit']>[0],descriptor:Parameters<MediaCheckpointJournal['commit']>[1]){calls.push('commit');const journal=commitMediaCheckpoint(read()!,lease,descriptor,Date.now());write(journal);return clone(journal.status);},
   async cancel(){calls.push('cancel');const journal=read();if(!journal)throw Error('Unknown checkpoint journal');const next=cancelMediaCheckpoint(journal);write(next);return clone(next.status);},
  };
 };
 const forIdentity=async(identity:MediaCheckpointStatus['identity'])=>stub(await mediaCheckpointCoordinatorName(identity));
 const namespace={idFromName:(name:string):DurableObjectId=>({name,toString:()=>name,equals:other=>other.toString()===name}),get:(id:DurableObjectId)=>stub(id.toString())};
 return {calls,journals,forIdentity,namespace,stored:async(identity:MediaCheckpointStatus['identity'])=>journals.get(await mediaCheckpointCoordinatorName(identity))!};
}
interface Counter {received:number;emitted:number}
function component(storage:ReturnType<typeof bucket>,unit=3){
 const hooks={process:undefined as ((position:string)=>void|Promise<void>)|undefined};
 const make=(spec:MediaCheckpointWorkflowSpec):MediaCheckpointComponent<Counter>=>{
  const pin=spec.inputs[0]!;
  return {
   create:()=>({received:0,emitted:0}),
   restore:bytes=>JSON.parse(new TextDecoder().decode(bytes)) as Counter,
   async process(state,position){
    await hooks.process?.(position.inputPosition);
    // Reads only through the spec's pinned generation.
    const object=await storage.bucket.get(pin.key,{onlyIf:{etagMatches:pin.etag}});if(!object||!('body' in object))throw Error('Pinned input changed');const bytes=new Uint8Array(await object.arrayBuffer());
    const from=Number(position.inputPosition),to=Math.min(bytes.length,from+unit),output=bytes.subarray(from,to);state.received=to;state.emitted+=output.length;return {output:output.length?output:null,inputPosition:String(to),finished:to===bytes.length};
   },
   serialize:state=>new TextEncoder().encode(JSON.stringify(state)),
   verify:(state,position)=>String(state.received)===position.inputPosition&&String(state.emitted)===position.outputPosition,
  };
 };
 return {hooks,make};
}
function filesystem(){
 const published=new Map<string,Uint8Array>(),openWrite=vi.fn(async(path:string)=>{const writes:Uint8Array[]=[];return {async write(bytes:Uint8Array){writes.push(bytes.slice());},async commit(){published.set(path,Uint8Array.from(writes.flatMap(bytes=>[...bytes])));},async abort(){writes.length=0;}};});
 const openRead=vi.fn(async(path:string)=>{const bytes=published.get(path);if(!bytes)throw Error('Missing destination');return {size:BigInt(bytes.length),readAt:async(offset:bigint,length:number)=>bytes.slice(Number(offset),Number(offset)+length)};});
 const files:VirtualFileSystem={openRead,openWrite,outputExists:async path=>published.has(path)};return {files,published,openWrite};
}
// Durable step semantics: a completed name returns its cached clone; a failing callback is retried up to `limit` times
// with a 1-based attempt context. `timeout` may time an attempt out the way the local engine does (Promise.race): the
// retry starts while the abandoned callback keeps running, and that callback is collected in `abandoned`.
function engine(options:{context?:boolean;timeout?:(name:string,attempt:number)=>Promise<void>|undefined}={}){
 const cache=new Map<string,unknown>(),names:string[]=[],sleeps:[string,number][]=[],attempts=new Map<string,number>(),abandoned:Promise<unknown>[]=[];
 const step:MediaCheckpointWorkflowStep={
  async do(name,config,callback){
   names.push(name);if(cache.has(name))return structuredClone(cache.get(name)) as never;let failure:unknown;
   for(let attempt=1;attempt<=config.retries.limit+1;attempt++){
    attempts.set(name,attempt);const task=callback(options.context===false?undefined:{attempt}),limit=options.timeout?.(name,attempt);
    try{const value=structuredClone(limit?await Promise.race([task,limit.then(()=>{throw Error('Execution timed out');})]):await task);cache.set(name,value);return structuredClone(value);}
    catch(error){failure=error;if(limit)abandoned.push(task.catch(()=>null));}
   }
   throw failure;
  },
  async sleep(name,duration){names.push(name);if(cache.has(name))return;cache.set(name,true);const timestamp=Date.now()+duration;sleeps.push([name,timestamp]);if(duration>0)vi.setSystemTime(timestamp);},
 };
 return {step,cache,names,sleeps,attempts,abandoned};
}
async function setup(policy:Record<string,number>={},workflowId='wf'){
 const storage=bucket(),journal=coordinators(),adapter=component(storage),output=filesystem();await storage.bucket.put('inputs/source.bin',input);
 const registry=new Map([['counter',{implementationVersion:'counter-v1',bind:vi.fn(({spec}:{spec:MediaCheckpointWorkflowSpec})=>({component:adapter.make(spec),filesystem:output.files}))}]]);
 const build=(id=workflowId,extra:Record<string,number>=policy)=>buildMediaCheckpointWorkflowSpec({bucket:storage.bucket,workflowId:id,jobId:'counter-job',workUnitId:'bytes',component:'counter',config:{unit:3,mode:{a:1,b:[true,null,'x']}},implementationVersion:'counter-v1',inputs:[{key:'inputs/source.bin'}],output:{path:'/final.bin',maxWriteBytes:4},policy:{leaseMs:1000,unitsPerInvocation:1,maxRetries:2,retryDelayMs:10,pollIntervalMs:25,...extra}});
 const spec=await build(),deps=(components:MediaCheckpointComponentRegistry=registry)=>({bucket:storage.bucket,components,journal:journal.forIdentity});
 const run=(durable=engine(),value:MediaCheckpointWorkflowSpec=spec,components:MediaCheckpointComponentRegistry=registry)=>runMediaCheckpointWorkflow({instanceId:value.workflowId,payload:value},durable.step,deps(components));
 return {storage,journal,adapter,output,registry,spec,build,deps,run};
}
it('builds an immutable spec that pins inputs and binds component, config and policy into separate identities',async()=>{
 const run=await setup(),spec=run.spec,pin=run.storage.entries.get('inputs/source.bin')!;
 expect(spec.inputs).toEqual([{key:'inputs/source.bin',etag:pin.etag,version:pin.version,size:10}]);expect(Object.isFrozen(spec)&&Object.isFrozen(spec.policy)&&Object.isFrozen(spec.inputs[0])).toBe(true);
 expect(spec.identity).toMatchObject({jobId:'counter-job',workUnitId:'bytes',implementationVersion:'counter-v1',graphHash:await mediaCheckpointWorkflowGraphHash('counter',{mode:{b:[true,null,'x'],a:1},unit:3})});
 expect(spec.output).toEqual({path:'/final.bin',overwrite:false,maxWriteBytes:4,maxReadBytes:4});expect(spec.policy).toMatchObject({leaseMs:1000,unitsPerInvocation:1,maxObjectBytes:8388608,maxCommitAttempts:3,maxInvocations:512,stepTimeoutMs:600000});
 expect(await verifyMediaCheckpointWorkflowSpec(spec)).toEqual(spec);expect(await hashMediaCheckpointWorkflowSpec(spec)).toBe(spec.specHash);
 // Scheduling policy changes the spec, never the journal identity; config changes both.
 const rescheduled=await run.build('wf',{unitsPerInvocation:4});expect(rescheduled.identity).toEqual(spec.identity);expect(rescheduled.specHash).not.toBe(spec.specHash);
 const reordered=await buildMediaCheckpointWorkflowSpec({bucket:run.storage.bucket,workflowId:'wf',jobId:'counter-job',workUnitId:'bytes',component:'counter',config:{mode:{b:[true,null,'x'],a:1},unit:3},implementationVersion:'counter-v1',inputs:[{key:'inputs/source.bin'}],output:{path:'/final.bin',maxWriteBytes:4},policy:{leaseMs:1000,unitsPerInvocation:1,maxRetries:2,retryDelayMs:10,pollIntervalMs:25}});expect(reordered.specHash).toBe(spec.specHash);
 expect(await mediaCheckpointWorkflowGraphHash('counter',{unit:4})).not.toBe(spec.identity.graphHash);
 // A new input generation is a new identity.
 await run.storage.bucket.put('inputs/source.bin',input);const repinned=await run.build();expect(repinned.identity.inputFingerprint).not.toBe(spec.identity.inputFingerprint);
 const rehash=async(value:MediaCheckpointWorkflowSpec)=>({...value,specHash:await hashMediaCheckpointWorkflowSpec(value)});
 await expect(verifyMediaCheckpointWorkflowSpec({...spec,policy:{...spec.policy,maxRetries:0}})).rejects.toThrow(/specification hash mismatch/);
 await expect(verifyMediaCheckpointWorkflowSpec(await rehash({...spec,config:{unit:4}}))).rejects.toThrow(/does not bind/);
 await expect(verifyMediaCheckpointWorkflowSpec(await rehash({...spec,inputs:[{...spec.inputs[0]!,etag:'other'}]}))).rejects.toThrow(/does not bind/);
 await expect(verifyMediaCheckpointWorkflowSpec({...spec,identity:{...spec.identity,jobId:'bad/id'}})).rejects.toThrow();
});
it('rejects malformed requests before pinning any input',async()=>{
 const run=await setup();run.storage.head.mockClear();
 const base={bucket:run.storage.bucket,workflowId:'wf',jobId:'job',workUnitId:'unit',component:'counter',implementationVersion:'v1',inputs:[{key:'inputs/source.bin'}],output:{path:'/out.bin'}};
 const cases:Record<string,unknown>[]=[{workflowId:'-bad'},{workflowId:'x'.repeat(65)},{component:'bad name'},{implementationVersion:''},{jobId:'a/b'},{inputs:[]},{inputs:Array.from({length:17},(_,index)=>({key:'k'+index}))},{inputs:[{key:'a'},{key:'a'}]},{inputs:[{key:'/abs'}]},{output:{path:'relative'}},{output:{path:'/a/../b'}},{output:{path:'/out',overwrite:'no'}},{output:{path:'/out',maxWriteBytes:2048},policy:{maxObjectBytes:1024}},{output:{path:'/out',maxReadBytes:2048},policy:{maxObjectBytes:1024}},{output:{path:'/out',maxReadBytes:0}},{policy:{unitsPerInvocation:0}},{policy:{unitsPerInvocation:257}},{policy:{maxInvocations:513}},{policy:{maxRetries:11}},{policy:{leaseMs:9}},{policy:{retryDelayMs:5}},{policy:{pollIntervalMs:300001}},{policy:{stepTimeoutMs:999}},{policy:{leaseMs:60000,unitsPerInvocation:8}},{policy:{leaseMs:1000,unitsPerInvocation:4,stepTimeoutMs:6999}},{policy:{maxCommitAttempts:9}},{config:Number.NaN},{config:{nested:{a:{b:{c:{d:{e:{f:{g:{h:1}}}}}}}}}},{config:{when:new Date(0)}},{config:{'bad key':1}},{config:'x'.repeat(4097)},{config:Array.from({length:257},()=>0)},{config:()=>1}];
 for(const extra of cases)await expect(buildMediaCheckpointWorkflowSpec({...base,...extra} as Parameters<typeof buildMediaCheckpointWorkflowSpec>[0])).rejects.toThrow();
 expect(run.storage.head).not.toHaveBeenCalled();
 await expect(buildMediaCheckpointWorkflowSpec({...base,inputs:[{key:'inputs/missing.bin'}]})).rejects.toThrow(/missing checkpoint workflow input/);
});
it('drives yielded invocations to a verified destination and one immutable manifest, without waiting for its own lease',async()=>{
 const run=await setup(),durable=engine(),manifest=await run.run(durable);
 expect(durable.names).toEqual(['validate-checkpoint-workflow','unit-0','unit-1','unit-2','unit-3','publish-checkpoint-workflow-result']);expect(durable.sleeps).toEqual([]);
 expect(durable.cache.get('unit-1')).toMatchObject({outcome:'yielded',revision:2,units:1});expect(durable.cache.get('unit-3')).toMatchObject({outcome:'finished',revision:4,bytes:'10',sha256:inputSha256,existing:false});
 // One claim and one owner across four invocations: each yield handed its lease to the next step.
 const journal=await run.journal.stored(run.spec.identity);expect(journal.status).toMatchObject({phase:'finished',revision:4,lease:null});expect(new Set(journal.committers.map(owner=>owner.token))).toEqual(new Set(['owner1']));expect(run.journal.calls.filter(call=>call==='claim')).toHaveLength(1);
 expect([...run.output.published.get('/final.bin')!]).toEqual([...input]);expect(run.output.openWrite).toHaveBeenCalledOnce();
 const key=`checkpoint-workflows/wf/${run.spec.specHash}.json`,stored=run.storage.entries.get(key)!;expect(manifest).toMatchObject({workflowId:'wf',specHash:run.spec.specHash,key,etag:stored.etag,version:stored.version,size:stored.bytes.length,path:'/final.bin',bytes:'10',outputSha256:inputSha256,revisions:4});
 // The manifest pins the destination content finalization published, not only the journal that produced it.
 const body=JSON.parse(new TextDecoder().decode(stored.bytes));expect(body).toMatchObject({version:1,workflowId:'wf',specHash:run.spec.specHash,identity:run.spec.identity,output:{path:'/final.bin',bytes:'10',sha256:inputSha256,revisions:4,outputChunks:4},journal:{revision:4,inputPosition:'10',outputPosition:'10',sha256:manifest.journalSha256}});
 expect(stored.metadata).toEqual({edgeCheckpointWorkflowId:'wf',edgeCheckpointWorkflowSpecHash:run.spec.specHash,edgeCheckpointWorkflowResultSha256:manifest.sha256});
 // Replaying the same history re-reads nothing: every step result is cached.
 run.journal.calls.length=0;expect(await run.run(durable)).toEqual(manifest);expect(run.journal.calls).toEqual([]);
 // A direct republish verifies the stored bytes and keeps the object generation.
 expect(await publishMediaCheckpointWorkflowResult(run.storage.bucket,run.spec,journal.status,{filesystem:run.output.files})).toEqual(manifest);
 // Another instance for the same identity verifies the existing destination and writes its own manifest.
 const other=await run.build('wf-replay'),replay=engine(),second=await run.run(replay,other);expect(replay.names).toEqual(['validate-checkpoint-workflow','unit-0','publish-checkpoint-workflow-result']);expect(replay.cache.get('unit-0')).toMatchObject({outcome:'finished',existing:true,sha256:inputSha256});
 expect(second.key).toBe(`checkpoint-workflows/wf-replay/${other.specHash}.json`);expect(second.journalSha256).toBe(manifest.journalSha256);expect(second.outputSha256).toBe(inputSha256);expect(run.output.openWrite).toHaveBeenCalledOnce();expect(run.storage.entries.get(key)!.version).toBe(manifest.version);
});
it('sleeps until a foreign lease expires, then claims and finishes',async()=>{
 const run=await setup({unitsPerInvocation:8}),journal=await run.journal.forIdentity(run.spec.identity);await journal.initialize(run.spec.identity);const foreign=(await journal.claim(5000))!;
 const durable=engine();await run.run(durable);expect(durable.names).toEqual(['validate-checkpoint-workflow','unit-0','busy-0','unit-1','publish-checkpoint-workflow-result']);
 expect(durable.cache.get('unit-0')).toMatchObject({outcome:'busy',revision:0,wakeAt:foreign.lease.expiresAt+25});expect(durable.sleeps).toEqual([['busy-0',foreign.lease.expiresAt+25]]);
 expect((await run.journal.stored(run.spec.identity)).committers.every(owner=>owner.token!==foreign.lease.token)).toBe(true);
});
it('retries transient failures inside the bounded step and continues the same lease',async()=>{
 const run=await setup();let failures=1;run.adapter.hooks.process=position=>{if(position==='3'&&failures-->0)throw Error('transient R2 read failure');};
 const durable=engine();await run.run(durable);expect(durable.attempts.get('unit-1')).toBe(2);expect(durable.sleeps).toEqual([]);expect([...run.output.published.get('/final.bin')!]).toEqual([...input]);
 expect(new Set((await run.journal.stored(run.spec.identity)).committers.map(owner=>owner.token)).size).toBe(1);
 // Exhausted retries surface the provider error from the step and stop scheduling.
 const exhausted=await setup();exhausted.adapter.hooks.process=()=>{throw Error('R2 unavailable');};const failing=engine();
 await expect(exhausted.run(failing)).rejects.toThrow(/R2 unavailable/);expect(failing.attempts.get('unit-0')).toBe(3);expect(failing.names).toEqual(['validate-checkpoint-workflow','unit-0']);expect((await exhausted.journal.stored(exhausted.spec.identity)).status.revision).toBe(0);
 expect([Error('x'),new AggregateError([],'y'),TypeError('z'),RangeError('w')].map(retryableMediaCheckpointWorkflowError)).toEqual([true,true,false,false]);
});
it('ends deterministically on a non-retryable failure, cancellation, lease loss and an output conflict',async()=>{
 const outcome=async(run:Awaited<ReturnType<typeof setup>>,durable=engine())=>{const error=await run.run(durable).catch((value:unknown)=>value);expect(error).toBeInstanceOf(MediaCheckpointWorkflowError);return {error:error as MediaCheckpointWorkflowError,durable};};
 const invalid=await setup();invalid.registry.get('counter')!.bind.mockImplementation(({spec})=>({component:{...invalid.adapter.make(spec),process:async()=>({output:null,inputPosition:'01',finished:false})},filesystem:invalid.output.files}));
 const failed=await outcome(invalid);expect(failed.error).toMatchObject({outcome:'failed',revision:null});expect(failed.error.message).toMatch(/Invalid checkpoint unit result/);expect(failed.durable.attempts.get('unit-0')).toBe(1);
 const cancelled=await setup();await cancelled.run(engine(),await cancelled.build('probe',{maxInvocations:1})).catch(()=>null);const journal=await cancelled.journal.forIdentity(cancelled.spec.identity);await journal.cancel();
 const fenced=await outcome(cancelled);expect(fenced.error).toMatchObject({outcome:'cancelled',revision:1});expect(fenced.durable.names).toEqual(['validate-checkpoint-workflow','unit-0']);
 const between=await setup();between.adapter.hooks.process=position=>{if(position==='6')void between.journal.forIdentity(between.spec.identity).then(stub=>stub.cancel());};
 const late=await outcome(between);expect(late.error).toMatchObject({outcome:'cancelled',revision:2});expect((await between.journal.stored(between.spec.identity)).status).toMatchObject({phase:'cancelled',revision:2});
 const stolen=await setup();stolen.adapter.hooks.process=position=>{if(position==='3'){advance(2000);void stolen.journal.forIdentity(stolen.spec.identity).then(stub=>stub.claim(60000));}};
 const lost=await outcome(stolen);expect(lost.error).toMatchObject({outcome:'lease-lost'});expect((await stolen.journal.stored(stolen.spec.identity)).status.revision).toBe(1);
 const conflicting=await setup({unitsPerInvocation:8});conflicting.output.published.set('/final.bin',Uint8Array.of(7,7));
 const conflict=await outcome(conflicting);expect(conflict.error).toMatchObject({outcome:'output-conflict',revision:4});expect(conflict.error.message).toMatch(/\/final\.bin holds 2 bytes .*journal assembles 10 bytes/);expect([...conflicting.output.published.get('/final.bin')!]).toEqual([7,7]);
 expect(conflict.durable.names).not.toContain('publish-checkpoint-workflow-result');expect([...conflicting.storage.entries.keys()].some(key=>key.startsWith('checkpoint-workflows/'))).toBe(false);
 // Another config for the same job and WorkUnit is a different identity on the same journal: it fails once, never retried.
 const reused=await setup({unitsPerInvocation:8});await reused.run();
 const changed=await buildMediaCheckpointWorkflowSpec({bucket:reused.storage.bucket,workflowId:'wf-changed',jobId:'counter-job',workUnitId:'bytes',component:'counter',config:{unit:4},implementationVersion:'counter-v1',inputs:[{key:'inputs/source.bin'}],output:{path:'/other.bin',maxWriteBytes:4},policy:{leaseMs:1000,unitsPerInvocation:8}});
 const mismatch=engine(),ended=await reused.run(mismatch,changed).catch((value:unknown)=>value);
 expect(ended).toMatchObject({outcome:'failed',revision:null});expect((ended as Error).message).toMatch(/identity conflicts with the journal/);expect(mismatch.attempts.get('unit-0')).toBe(1);expect((await reused.journal.stored(reused.spec.identity)).status).toMatchObject({phase:'finished',revision:4});
});
it('validates the request, registry entry and runner configuration before any journal call',async()=>{
 const run=await setup(),attempt=async(components:MediaCheckpointComponentRegistry,spec=run.spec,pattern:RegExp)=>{const durable=engine();await expect(run.run(durable,spec,components)).rejects.toThrow(pattern);expect(durable.attempts.get('validate-checkpoint-workflow')??0).toBeLessThanOrEqual(1);};
 await attempt(new Map(),run.spec,/Unregistered checkpoint workflow component/);
 await attempt(new Map([['counter',{...run.registry.get('counter')!,implementationVersion:'counter-v2'}]]),run.spec,/implementation version mismatch/);
 await attempt(new Map([['counter',{implementationVersion:'counter-v1',bind:()=>({component:run.adapter.make(run.spec),filesystem:{...run.output.files,openWrite:undefined} as unknown as VirtualFileSystem})}]]),run.spec,/finalize options/);
 await attempt(new Map([['counter',{implementationVersion:'counter-v1',bind:()=>({component:{} as MediaCheckpointComponent<unknown>,filesystem:run.output.files})}]]),run.spec,/journal or component/);
 await attempt(run.registry,{...run.spec,policy:{...run.spec.policy,maxRetries:0}},/specification hash mismatch/);
 await expect(runMediaCheckpointWorkflow({instanceId:'other',payload:run.spec},engine().step,run.deps())).rejects.toThrow(/instance identity mismatch/);
 expect(run.journal.calls).toEqual([]);
 // The invocation budget bounds scheduling even when every unit yields.
 const bounded=await setup({maxInvocations:2}),durable=engine(),error=await bounded.run(durable).catch((value:unknown)=>value);expect(error).toMatchObject({outcome:'exhausted'});expect(durable.names).toEqual(['validate-checkpoint-workflow','unit-0','unit-1']);
 // Busy sleeps count against the same budget, so an instance has at most maxInvocations + 2 steps.
 const sleepy=await setup({maxInvocations:2,unitsPerInvocation:8}),held=await sleepy.journal.forIdentity(sleepy.spec.identity);await held.initialize(sleepy.spec.identity);await held.claim(5000);
 const waiting=engine();expect(await sleepy.run(waiting).catch((value:unknown)=>value)).toMatchObject({outcome:'exhausted'});expect(waiting.names).toEqual(['validate-checkpoint-workflow','unit-0','busy-0']);
});
it('publishes the manifest conditionally, verifies the exact stored body after a lost acknowledgement and never for an unverified destination',async()=>{
 const run=await setup({unitsPerInvocation:8});await run.run(engine(),await run.build('first'));const status=(await run.journal.stored(run.spec.identity)).status,binding={filesystem:run.output.files},publish=(spec=run.spec,value=status)=>publishMediaCheckpointWorkflowResult(run.storage.bucket,spec,value,binding);
 run.storage.faults.lostPut=1;const manifest=await publish();expect(run.storage.entries.get(manifest.key)!.version).toBe(manifest.version);expect(manifest.outputSha256).toBe(inputSha256);
 expect(await publish()).toEqual(manifest);
 const stored=run.storage.entries.get(manifest.key)!;stored.bytes=stored.bytes.map((byte,index)=>index===stored.bytes.length-2?byte^1:byte);await expect(publish()).rejects.toThrow(/byte conflict/);
 stored.metadata={...stored.metadata,edgeCheckpointWorkflowResultSha256:'0'.repeat(64)};await expect(publish()).rejects.toThrow(/result conflict/);
 await expect(publish(run.spec,{...status,phase:'running'})).rejects.toThrow(/finished journal/);
 await expect(publish(run.spec,{...status,identity:{...status.identity,jobId:'other'}})).rejects.toThrow(/finished journal/);
 await expect(publish({...run.spec,workflowId:'renamed'})).rejects.toThrow(/hash mismatch/);
 // The exported publication verifies the destination itself: different or missing content publishes nothing, and nothing is written.
 const other=await run.build('other'),key=`checkpoint-workflows/other/${other.specHash}.json`,writes=run.output.openWrite.mock.calls.length;
 run.output.published.set('/final.bin',input.map(byte=>byte^1));await expect(publish(other)).rejects.toBeInstanceOf(MediaCheckpointOutputConflictError);
 run.output.published.delete('/final.bin');await expect(publish(other)).rejects.toThrow(/Missing destination/);
 expect(run.storage.entries.has(key)).toBe(false);expect(run.output.openWrite.mock.calls.length).toBe(writes);expect(run.output.published.has('/final.bin')).toBe(false);
 run.output.published.set('/final.bin',input.slice());expect(await publish(other)).toMatchObject({key,outputSha256:inputSha256,journalSha256:manifest.journalSha256});
});
it('never hands a lease to an attempt that may still be running',async()=>{
 const run=await setup();let entered:()=>void=()=>{},release:()=>void=()=>{},blocked=false;const inside=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 run.adapter.hooks.process=position=>{if(position!=='3'||blocked)return;blocked=true;entered();return gate;};
 // The first attempt of unit-1 resumes the yielded lease and times out inside its unit; the engine retries while it still runs.
 const durable=engine({timeout:(name,attempt)=>name==='unit-1'&&attempt===1?inside:undefined}),manifest=await run.run(durable);
 expect(durable.attempts.get('unit-1')).toBe(2);expect(durable.cache.get('unit-1')).toMatchObject({outcome:'busy',revision:1});expect(durable.sleeps.map(([name])=>name)).toEqual(['busy-1']);
 // The retry's refused claim drew a token too, so the next owner is the third token, not a reuse of the first.
 const journal=await run.journal.stored(run.spec.identity);expect(journal.committers.map(owner=>owner.token)).toEqual(['owner1','owner3','owner3','owner3']);expect(run.journal.calls.filter(call=>call==='claim')).toHaveLength(3);
 // Released after the instance finished, the abandoned attempt can no longer commit under its expired lease.
 release();await Promise.all(durable.abandoned);expect((await run.journal.stored(run.spec.identity)).committers).toEqual(journal.committers);expect([...run.output.published.get('/final.bin')!]).toEqual([...input]);expect(manifest.revisions).toBe(4);
 // An engine that reports no attempt number gets no handoff at all: every yield is followed by a claim that waits out the lease.
 const blind=await setup(),unaware=engine({context:false});await blind.run(unaware);
 expect(unaware.sleeps).toHaveLength(3);expect(new Set((await blind.journal.stored(blind.spec.identity)).committers.map(owner=>owner.token)).size).toBe(4);expect([...blind.output.published.get('/final.bin')!]).toEqual([...input]);
});
it('stops an attempt at its own deadline and continues like a yield',async()=>{
 // A 1100 ms step timeout with 10 ms leases leaves a 90 ms deadline; each unit takes 60 ms of real time while the journal clock stands still.
 const run=await setup({leaseMs:10,unitsPerInvocation:4,stepTimeoutMs:1100});let processed=0;run.adapter.hooks.process=()=>{processed++;return new Promise(resolve=>setTimeout(resolve,60));};
 const durable=engine(),manifest=await run.run(durable),units=[...durable.cache].filter(([name])=>name.startsWith('unit-')).map(([,value])=>value as {outcome:string;units?:number});
 expect(units[0]).toMatchObject({outcome:'yielded'});expect(units[0]!.units).toBeLessThan(4);expect(units.at(-1)).toMatchObject({outcome:'finished'});expect(units.slice(0,-1).every(unit=>unit.outcome==='yielded')).toBe(true);
 // The stopped attempt committed nothing for the unit it was processing, handed its lease on and never waited.
 expect(processed).toBeGreaterThan(4);expect(durable.sleeps).toEqual([]);expect(run.journal.calls.filter(call=>call==='claim')).toHaveLength(1);expect(manifest).toMatchObject({revisions:4,outputSha256:inputSha256});
});
it('fences the journal before terminating, tombstones an unstarted journal and never terminates after a failed fence',async()=>{
 const run=await setup(),events:string[]=[],terminate=vi.fn(async()=>{events.push('terminate');}),status=vi.fn(async()=>({status:'running'})),workflow={get:vi.fn(async()=>({terminate,status}))};
 const CHECKPOINTS={idFromName:run.journal.namespace.idFromName,get:(id:DurableObjectId)=>{const stub=run.journal.namespace.get(id);return {...stub,cancel:async()=>{events.push('fence');return stub.cancel();}};}};
 const result=await cancelMediaCheckpointWorkflow(run.spec,{workflow,CHECKPOINTS});expect(result).toEqual({workflowId:'wf',specHash:run.spec.specHash,journalPhase:'cancelled',revision:0,workflowStatus:'terminated'});expect(events).toEqual(['fence','terminate']);
 // The tombstone makes a late instance end as cancelled before any unit runs.
 const late=await run.run().catch((error:unknown)=>error);expect(late).toMatchObject({outcome:'cancelled',revision:0});
 // Repeating the request is idempotent; an already finished instance is reconciled by its platform status.
 terminate.mockRejectedValueOnce(Error('instance.cannot_terminate'));status.mockResolvedValueOnce({status:'errored'});expect(await cancelMediaCheckpointWorkflow(run.spec,{workflow,CHECKPOINTS})).toMatchObject({journalPhase:'cancelled',workflowStatus:'errored'});
 terminate.mockRejectedValueOnce(Error('transport'));const partial=await cancelMediaCheckpointWorkflow(run.spec,{workflow,CHECKPOINTS}).catch((error:unknown)=>error);expect(partial).toBeInstanceOf(MediaCheckpointWorkflowCancellationError);expect((partial as MediaCheckpointWorkflowCancellationError).details).toMatchObject({fenced:true,journalPhase:'cancelled',workflowStatus:'running',terminationConfirmed:false,failures:[{target:'workflow',message:'transport'}]});
 // A failed fence never terminates the instance.
 const broken=await setup();terminate.mockClear();const failure=await cancelMediaCheckpointWorkflow(broken.spec,{workflow,CHECKPOINTS:{idFromName:broken.journal.namespace.idFromName,get:()=>({initialize:async()=>{throw Error('DO unavailable');},cancel:async()=>{throw Error('unreachable');}})}}).catch((error:unknown)=>error);
 expect((failure as MediaCheckpointWorkflowCancellationError).details).toMatchObject({fenced:false,journalPhase:null,terminationConfirmed:false,failures:[{target:'journal',message:'DO unavailable'}]});expect(terminate).not.toHaveBeenCalled();
 // A finished journal stays finished and its instance is not terminated: that could only cut off finalization or publication.
 const done=await setup({unitsPerInvocation:8});await done.run();terminate.mockClear();const finished=await cancelMediaCheckpointWorkflow(done.spec,{workflow,CHECKPOINTS:{idFromName:done.journal.namespace.idFromName,get:done.journal.namespace.get}});
 expect(finished).toEqual({workflowId:'wf',specHash:done.spec.specHash,journalPhase:'finished',revision:4,workflowStatus:'running'});expect(terminate).not.toHaveBeenCalled();expect([...done.output.published.get('/final.bin')!]).toEqual([...input]);
 status.mockRejectedValueOnce(Error('status unavailable'));const unread=await cancelMediaCheckpointWorkflow(done.spec,{workflow,CHECKPOINTS:{idFromName:done.journal.namespace.idFromName,get:done.journal.namespace.get}}).catch((error:unknown)=>error);
 expect((unread as MediaCheckpointWorkflowCancellationError).details).toMatchObject({fenced:true,journalPhase:'finished',revision:4,workflowStatus:null,failures:[{target:'workflow',message:'status unavailable'}]});expect(terminate).not.toHaveBeenCalled();
});
