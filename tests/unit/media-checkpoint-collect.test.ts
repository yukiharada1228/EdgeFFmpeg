import {expect,it} from 'vitest';
import type {R2Bucket} from '@cloudflare/workers-types';
import type {ExecutionCheckpointIdentity} from '../../packages/core/src/index.js';
import type {MediaCheckpointDescriptor,MediaCheckpointLease,MediaCheckpointStatus} from '../../packages/runtime-cloudflare/src/checkpoints/types.js';
import {cancelMediaCheckpoint,claimMediaCheckpoint,commitMediaCheckpoint,expireMediaCheckpoint,initializeMediaCheckpoint,mediaCheckpointCoordinatorName} from '../../packages/runtime-cloudflare/src/checkpoints/state.js';
import {loadMediaCheckpoint,prepareMediaCheckpoint} from '../../packages/runtime-cloudflare/src/checkpoints/artifacts.js';
import {MediaCheckpointCollectionError,collectMediaCheckpointOrphans} from '../../packages/runtime-cloudflare/src/checkpoints/collect.js';
import type {CollectMediaCheckpointOrphansOptions} from '../../packages/runtime-cloudflare/src/checkpoints/collect.js';
const identity:ExecutionCheckpointIdentity={jobId:'collect',workUnitId:'fifo',graphHash:'a'.repeat(64),inputFingerprint:'b'.repeat(64),implementationVersion:'v1'},other={...identity,jobId:'collect-other'};
type Page={objects:{key:string;customMetadata?:Record<string,string>}[];delimitedPrefixes:string[];truncated:boolean;cursor?:string};
type List={prefix:string;limit:number;include?:string[];cursor?:string;startAfter?:string};
// R2-shaped fake: conditional puts, lexicographic prefix listing with opaque cursors and optional custom metadata, batch deletes.
function storage(){
 const entries=new Map<string,{bytes:Uint8Array;version:string;etag:string;metadata:Record<string,string>}>(),events:string[]=[],lists:List[]=[],deletes:string[][]=[];let sequence=0;
 // `fail` returns how many keys of a batch are deleted before the call throws (the batch length is a lost acknowledgement).
 const hooks={list:undefined as (()=>unknown)|undefined,page:undefined as ((page:Page)=>Page)|undefined,delete:undefined as (()=>unknown)|undefined,fail:undefined as ((batch:string[])=>number|undefined)|undefined,failOutput:false};
 const provider={
  async put(key:string,value:Uint8Array,options:{customMetadata:Record<string,string>}){if(hooks.failOutput&&key.endsWith('/output.bin'))throw Error('Injected output put failure');if(entries.has(key))return null;const object={bytes:value.slice(),version:'v'+(++sequence),etag:'e'+sequence,metadata:{...options.customMetadata}};entries.set(key,object);return {key,version:object.version,etag:object.etag,size:object.bytes.length};},
  async get(key:string,options?:{onlyIf:{etagMatches:string}}){const object=entries.get(key);if(!object)return null;const base={key,version:object.version,etag:object.etag,size:object.bytes.length,customMetadata:object.metadata};if(options&&options.onlyIf.etagMatches!==object.etag)return base;return {...base,body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(object.bytes.slice());controller.close();}})};},
  async list(options:List){
   events.push('list');lists.push(structuredClone(options));await hooks.list?.();const after=options.cursor!==undefined?options.cursor.slice(1):options.startAfter??'',keys=[...entries.keys()].filter(key=>key.startsWith(options.prefix)&&key>after).sort(),objects=keys.slice(0,options.limit).map(key=>options.include?.includes('customMetadata')?{key,customMetadata:{...entries.get(key)!.metadata}}:{key});
   const page:Page=keys.length>options.limit?{objects,delimitedPrefixes:[],truncated:true,cursor:'@'+objects.at(-1)!.key}:{objects,delimitedPrefixes:[],truncated:false};return hooks.page?hooks.page(page):page;
  },
  async delete(keys:string|string[]){events.push('delete');const batch=typeof keys==='string'?[keys]:[...keys];deletes.push(batch);const fail=hooks.fail?.(batch);for(const [index,key]of batch.entries()){if(index===fail)break;entries.delete(key);}if(fail!==undefined)throw Error('Injected delete failure');await hooks.delete?.();},
 };
 const put=(key:string,metadata:Record<string,string>={})=>entries.set(key,{bytes:Uint8Array.of(1),version:'x',etag:'x',metadata});
 return {bucket:provider as unknown as R2Bucket,entries,events,lists,deletes,hooks,put,keys:(prefix:string)=>[...entries.keys()].filter(key=>key.startsWith(prefix)).sort()};
}
// Pure state.ts transitions stand in for the Durable Object; structuredClone stands in for RPC copies.
async function coordinator(store:ReturnType<typeof storage>,value=identity){
 const name=await mediaCheckpointCoordinatorName(value);let stored=initializeMediaCheckpoint(null,value,name),now=1000,token=0;
 const hooks={status:undefined as (()=>unknown)|undefined,rewrite:undefined as ((status:MediaCheckpointStatus)=>MediaCheckpointStatus)|undefined};
 const journal={async status(){store.events.push('status');await hooks.status?.();stored=expireMediaCheckpoint(stored,now);const status=structuredClone(stored.status);return hooks.rewrite?hooks.rewrite(status):status;}};
 const claim=()=>{const result=claimMediaCheckpoint(stored,100,now,'owner'+(++token));stored=result.journal;return result.claim!.lease;};
 const prepare=(lease:MediaCheckpointLease,revision:number,finished=false)=>prepareMediaCheckpoint(store.bucket,value,lease,{revision,inputPosition:String(revision*4),outputPosition:String(revision*3),state:Uint8Array.of(revision,lease.generation),output:Uint8Array.of(revision,2,3),finished});
 const commit=(lease:MediaCheckpointLease,descriptor:MediaCheckpointDescriptor)=>{stored=commitMediaCheckpoint(stored,lease,descriptor,now);};
 return {journal,claim,prepare,commit,hooks,root:'checkpoints/'+name+'/',expire(){now+=1000;},cancel(){stored=cancelMediaCheckpoint(stored);},get status(){return stored.status;}};
}
// A commits r1 and stages r2 before losing its lease; B stages only r2 state (output put failed); C commits the terminal r2.
async function history(){
 const store=storage(),run=await coordinator(store),a=run.claim(),a1=await run.prepare(a,1);run.commit(a,a1);const a2=await run.prepare(a,2,true);run.expire();
 const b=run.claim();store.hooks.failOutput=true;await expect(run.prepare(b,2,true)).rejects.toThrow(/prepared/);store.hooks.failOutput=false;run.expire();
 const c=run.claim(),c2=await run.prepare(c,2,true);run.commit(c,c2);expect(run.status).toMatchObject({phase:'finished',revision:2,lease:null});
 return {store,run,a2,orphans:[a2.output!.key,a2.state.key,run.root+'2/owner2/revision-2/state.bin'].sort(),committed:[a1.state.key,a1.output!.key,c2.state.key,c2.output!.key].sort()};
}
const collector=(store:ReturnType<typeof storage>,run:{journal:CollectMediaCheckpointOrphansOptions['journal']},value=identity)=>(extra:Partial<CollectMediaCheckpointOrphansOptions>={})=>collectMediaCheckpointOrphans({bucket:store.bucket,journal:run.journal,identity:value,...extra});
const retained=(report:{readonly kept:readonly {key:string;reason:string}[]})=>report.kept.map(entry=>entry.key+' '+entry.reason).sort(),include=['customMetadata'];
const failure=async(promise:Promise<unknown>)=>{const error=await promise.then(()=>undefined,(error:unknown)=>error);expect(error).toBeInstanceOf(MediaCheckpointCollectionError);return error as MediaCheckpointCollectionError;};
it('deletes only unreferenced attempt objects of a finished journal and keeps every committed object loadable',async()=>{
 const {store,run,orphans,committed}=await history(),foreign=await coordinator(store,other),collect=collector(store,run),f=foreign.claim(),staged=await foreign.prepare(f,1);foreign.expire();
 // Final output, its staging and traversal-shaped or non-attempt keys inside the prefix are never collectable.
 const stray=[run.root+'notes.txt',run.root+'1/owner1/revision-1/extra.bin',run.root+'01/owner1/revision-1/state.bin',run.root+'1/owner1/revision-1/../../../../final/out.raw',run.root+'1/owner/revision-257/state.bin'];for(const key of ['final/out.raw','final-stage/upload',...stray])store.put(key);
 // Attempt-shaped keys without the prepare digest marker (a VFS output mounted inside the prefix, a malformed marker) are not attempt objects.
 const vfs=run.root+'9/vfs/revision-1/output.bin',forged=run.root+'9/vfs/revision-1/state.bin';store.put(vfs,{edgeffmpegTransaction:'t'});store.put(forged,{edgeCheckpointSha256:'F'.repeat(64)});stray.push(vfs,forged);
 const report=await collect();expect(report).toMatchObject({outcome:'collected',phase:'finished',dryRun:false,prefix:run.root,pages:1,listed:14,next:null,skipped:[]});
 expect(report.deleted).toEqual(orphans.map(key=>({key,reason:'terminal'})));expect(retained(report)).toEqual([...committed.map(key=>key+' committed'),...stray.map(key=>key+' unrecognized')].sort());
 expect(store.events).toEqual(['status','list','status','status','delete']);expect(store.lists).toEqual([{prefix:run.root,limit:1000,include}]);expect(store.keys(run.root)).toEqual([...committed,...stray].sort());
 for(const commit of run.status.commits)expect(await loadMediaCheckpoint(store.bucket,commit)).toEqual({state:Uint8Array.of(commit.revision,commit.revision===1?1:3),output:Uint8Array.of(commit.revision,2,3)});
 for(const key of ['final/out.raw','final-stage/upload',staged.state.key,staged.output!.key])expect(store.entries.has(key)).toBe(true);
 const again=await collect();expect(again).toMatchObject({outcome:'collected',listed:11,deleted:[],skipped:[]});expect(retained(again)).toEqual(retained(report));expect(store.deletes).toHaveLength(1);
});
it('never lists or deletes under a live lease and fences only generations up to the last committer of a lease-free journal',async()=>{
 const store=storage(),run=await coordinator(store),collect=collector(store,run),a=run.claim(),a1=await run.prepare(a,1);run.commit(a,a1);const a2=await run.prepare(a,2);
 expect(await collect()).toEqual({outcome:'live-lease',phase:'running',dryRun:false,prefix:run.root,pages:0,listed:0,next:run.root,deleted:[],kept:[],skipped:[]});expect(store.events).toEqual(['status']);
 run.expire();const fenced=await collect();expect(fenced).toMatchObject({outcome:'collected',phase:'ready',skipped:[]});expect(fenced.deleted).toEqual([a2.output!.key,a2.state.key].map(key=>({key,reason:'fenced'})));
 // B held generation 2 but never committed: status() cannot prove it fenced while the journal is still claimable.
 const b=run.claim(),b2=await run.prepare(b,2);run.expire();const unfenced=await collect();expect(unfenced.deleted).toEqual([]);expect(unfenced.kept).toEqual([...[a1.output!.key,a1.state.key].map(key=>({key,reason:'committed'})),...[b2.output!.key,b2.state.key].map(key=>({key,reason:'unfenced'}))]);
 const c=run.claim(),c2=await run.prepare(c,2);run.commit(c,c2);const live=await collect();expect(live).toMatchObject({outcome:'live-lease',listed:0,deleted:[]});run.expire();
 const later=await collect();expect(later.deleted).toEqual([b2.output!.key,b2.state.key].map(key=>({key,reason:'fenced'})));expect(later.kept.map(entry=>entry.reason)).toEqual(['committed','committed','committed','committed']);expect(store.keys(run.root)).toEqual([a1.output!.key,a1.state.key,c2.output!.key,c2.state.key]);
 // Without any commit no expired generation is provably fenced.
 const empty=await coordinator(store,other),e=empty.claim(),staged=await empty.prepare(e,1);empty.expire();const none=await collector(store,empty,other)();expect(none.deleted).toEqual([]);expect(none.kept).toEqual([staged.output!.key,staged.state.key].map(key=>({key,reason:'unfenced'})));
});
it('lists in bounded pages, deletes in re-checked batches and continues from the reported key',async()=>{
 const {store,run,orphans,committed}=await history(),collect=collector(store,run),late:string[]=[];
 // Never-claimed generations: a finished journal fences every generation.
 for(let index=0;index<3;index++){const staged=await run.prepare({generation:4+index,token:'late'+index,expiresAt:1},2,true);late.push(staged.output!.key,staged.state.key);}
 const keys=[...orphans,...late,...committed].sort(),deleted:string[]=[],windows:{pages:number;listed:number;next:string|null}[]=[];let after:string|undefined;
 do{
  store.events.length=0;store.lists.length=0;const before=store.deletes.length,report=await collect({pageSize:2,maxObjects:5,...(after===undefined?{}:{startAfter:after})});windows.push({pages:report.pages,listed:report.listed,next:report.next});
  expect(store.lists.map(list=>list.limit)).toEqual(report.listed===5?[2,2,1]:[2,2]);expect(store.lists[0]).toEqual(after===undefined?{prefix:run.root,limit:2,include}:{prefix:run.root,limit:2,include,startAfter:after});expect(store.lists.slice(1).every(list=>list.cursor!==undefined&&list.startAfter===undefined)).toBe(true);
  // One journal read before every delete batch of at most pageSize keys.
  const batches=store.deletes.slice(before);expect(batches.every(batch=>batch.length<=2)).toBe(true);expect(store.events.slice(store.events.indexOf('status',1))).toEqual(['status',...batches.flatMap(()=>['status','delete'])]);
  deleted.push(...report.deleted.map(entry=>entry.key));after=report.next??undefined;
 }while(after!==undefined);
 expect(windows).toEqual([{pages:3,listed:5,next:keys[4]},{pages:3,listed:5,next:keys[9]},{pages:2,listed:3,next:null}]);expect(deleted.sort()).toEqual([...orphans,...late].sort());expect(store.keys(run.root)).toEqual(committed);
 const paged=await collect({pageSize:1,maxPages:2});expect(paged).toMatchObject({pages:2,listed:2,next:committed[1]});
});
it('re-reads the journal after listing and before deleting so racing claims and commits are never collected',async()=>{
 const store=storage(),run=await coordinator(store),collect=collector(store,run),a=run.claim(),a1=await run.prepare(a,1);run.commit(a,a1);const a2=await run.prepare(a,2);run.expire();
 // A claim while the listing is in flight: the post-listing read sees its live lease.
 store.hooks.list=()=>{run.claim();};const during=await collect();store.hooks.list=undefined;
 expect(during).toMatchObject({outcome:'live-lease',phase:'running',listed:4,next:a1.state.key,deleted:[],skipped:[]});expect(during.kept.map(entry=>entry.reason)).toEqual(['committed','committed','live-lease','live-lease']);expect(store.deletes).toEqual([]);run.expire();
 // A new owner claims and commits between the post-listing read and the delete: the pre-delete read stops the run.
 let reads=0;run.hooks.status=async()=>{if(++reads===3){const b=run.claim();run.commit(b,await run.prepare(b,2));}};
 const before=await collect();expect(before).toMatchObject({outcome:'live-lease',phase:'running',deleted:[]});expect(before.kept.filter(entry=>entry.key===a2.state.key||entry.key===a2.output!.key).map(entry=>entry.reason)).toEqual(['live-lease','live-lease']);expect(store.deletes).toEqual([]);
 expect(store.events.slice(-4)).toEqual(['status','list','status','status']);run.expire();
 // The racing owner finishes the journal between the reads: the pre-delete read authorizes the deletion as terminal.
 reads=0;let finished:MediaCheckpointDescriptor|undefined;run.hooks.status=async()=>{if(++reads===3){const d=run.claim();finished=await run.prepare(d,3,true);run.commit(d,finished);}};
 const terminal=await collect();run.hooks.status=undefined;expect(terminal).toMatchObject({outcome:'collected',phase:'finished'});expect(terminal.deleted).toEqual([a2.output!.key,a2.state.key].map(key=>({key,reason:'terminal'})));expect(store.entries.has(finished!.state.key)).toBe(true);
 // Objects committed during a listing are classified by the later read as committed.
 const job=storage(),racing=await coordinator(job),r=racing.claim(),r1=await racing.prepare(r,1);racing.commit(r,r1);const r2=await racing.prepare(r,2);racing.expire();
 job.hooks.list=async()=>{const s=racing.claim(),s2=await racing.prepare(s,2,true);racing.commit(s,s2);};const listed=await collector(job,racing)();
 expect(listed).toMatchObject({outcome:'collected',phase:'finished',listed:6});expect(listed.deleted).toEqual([r2.output!.key,r2.state.key].map(key=>({key,reason:'terminal'})));expect(listed.kept.map(entry=>entry.reason)).toEqual(['committed','committed','committed','committed']);
 // A journal that loses a commit between reads breaks the monotonic proof; nothing is deleted.
 const regress=await history();let count=0;regress.run.hooks.rewrite=status=>++count===2?{...status,phase:'ready',revision:1,inputPosition:'4',outputPosition:'3',commits:status.commits.slice(0,1)}:status;
 await expect(collector(regress.store,regress.run)()).rejects.toThrow(/regressed/);expect(regress.store.deletes).toEqual([]);
 count=0;regress.run.hooks.rewrite=status=>++count===3?{...status,phase:'cancelled'}:status;await expect(collector(regress.store,regress.run)()).rejects.toThrow(/regressed/);expect(regress.store.deletes).toEqual([]);
 // A rewritten earlier commit (same count) is also a regression.
 count=0;regress.run.hooks.rewrite=status=>++count===3?{...status,commits:status.commits.map((commit,index)=>index?commit:{...commit,state:{...commit.state,etag:'rewritten'}})}:status;await expect(collector(regress.store,regress.run)()).rejects.toThrow(/regressed/);expect(regress.store.deletes).toEqual([]);
});
it('bounds deletions and rejects invalid limits, malformed pages and inconsistent journals before deleting',async()=>{
 const {store,run,orphans}=await history(),collect=collector(store,run),foreign=await coordinator(store,other);
 for(const extra of [{maxObjects:0},{maxObjects:4097},{maxObjects:1.5},{maxDeletes:-1},{maxDeletes:0},{maxDeletes:4097},{maxPages:0},{maxPages:1025},{pageSize:0},{pageSize:1001}])await expect(collect(extra)).rejects.toThrow(RangeError);
 await expect(collect({dryRun:'yes' as unknown as boolean})).rejects.toThrow(TypeError);await expect(collect({journal:{} as CollectMediaCheckpointOrphansOptions['journal']})).rejects.toThrow(TypeError);await expect(collect({identity:{...identity,jobId:'../x'}})).rejects.toThrow(/identity/);expect(store.events).toEqual([]);
 expect(await collect({journal:{status:async()=>null}})).toMatchObject({outcome:'missing-journal',phase:null,pages:0,listed:0});expect(store.events).toEqual([]);
 const bounded=await collect({maxDeletes:1});expect(bounded.next).toBe(orphans[0]);expect(bounded.deleted).toEqual([{key:orphans[0],reason:'terminal'}]);expect(bounded.skipped).toEqual(orphans.slice(1).map(key=>({key,reason:'max-deletes'})));
 const deletes=store.deletes.length;
 const pages:[Partial<CollectMediaCheckpointOrphansOptions>,(page:Page)=>Page][]=[[{pageSize:1},page=>({...page,objects:[...page.objects,{key:run.root+'extra'}]})],[{},page=>({...page,objects:[{key:'final/out.raw'}]})],[{},page=>({...page,objects:[{key:foreign.root+'1/x/revision-1/state.bin'}]})],[{},page=>({...page,objects:[page.objects[0]!,page.objects[0]!]})],[{},page=>({...page,truncated:true})],[{pageSize:1},page=>({...page,objects:[]})]];
 for(const [extra,hook]of pages){store.hooks.page=hook;await expect(collect(extra)).rejects.toThrow(/listing/);}store.hooks.page=undefined;
 const repeated=storage(),journal=await coordinator(repeated);let first:Page|undefined;repeated.put(journal.root+'a');repeated.put(journal.root+'b');repeated.hooks.page=page=>first??=page;await expect(collector(repeated,journal)({pageSize:1})).rejects.toThrow(/repeated/);
 // Commit keys must belong to this journal's attempt layout; lease and phase must agree.
 const rewrites:[(status:MediaCheckpointStatus)=>MediaCheckpointStatus,RegExp][]=[[status=>({...status,commits:status.commits.map(commit=>({...commit,state:{...commit.state,key:foreign.root+'1/owner1/revision-'+commit.revision+'/state.bin'}}))}),/not owned/],[status=>({...status,commits:status.commits.map(commit=>({...commit,output:commit.output&&{...commit.output,key:commit.output.key.replace('owner','other')}}))}),/not owned/],[status=>({...status,commits:status.commits.map(commit=>({...commit,state:{...commit.state,key:commit.state.key.replace('/revision-','/revision-1')}}))}),/not owned/],[status=>({...status,lease:{generation:9,token:'late',expiresAt:1}}),/lease is inconsistent/],[status=>({...status,phase:'running'}),/lease is inconsistent/],[status=>({...status,identity:other}),/status is inconsistent/],[status=>({...status,commits:status.commits.slice(1)}),/status is inconsistent/]];
 for(const [rewrite,message]of rewrites){run.hooks.rewrite=rewrite;await expect(collect()).rejects.toThrow(message);}run.hooks.rewrite=undefined;expect(store.deletes).toHaveLength(deletes);
 expect(store.keys(run.root)).toEqual([...orphans.slice(1),...run.status.commits.flatMap(commit=>[commit.state.key,commit.output!.key])].sort());
});
it('dry-run reports the deletion plan a real run with the same bounds performs, without deleting or re-reading before deletion',async()=>{
 const {store,run,orphans}=await history(),collect=collector(store,run),dry=await collect({dryRun:true});
 expect(dry).toMatchObject({outcome:'collected',phase:'finished',dryRun:true,next:null,deleted:[]});expect(dry.skipped).toEqual(orphans.map(key=>({key,reason:'dry-run'})));expect(store.events).toEqual(['status','list','status']);expect(store.deletes).toEqual([]);expect(store.keys(run.root)).toHaveLength(7);
 // maxDeletes splits the plan exactly as the real run splits deleted and max-deletes keys, with the same continuation.
 const plan=await collect({dryRun:true,maxDeletes:1});expect(plan.skipped).toEqual([...orphans.slice(1).map(key=>({key,reason:'max-deletes'})),{key:orphans[0],reason:'dry-run'}]);expect(plan.next).toBe(orphans[0]);expect(store.deletes).toEqual([]);
 const bounded=await collect({maxDeletes:1});expect(bounded.deleted.map(entry=>entry.key)).toEqual(plan.skipped.filter(entry=>entry.reason==='dry-run').map(entry=>entry.key));expect(bounded.skipped).toEqual(plan.skipped.filter(entry=>entry.reason==='max-deletes'));expect(bounded.kept).toEqual(plan.kept);expect(bounded.next).toBe(plan.next);
 const rest=await collect({dryRun:true,startAfter:plan.next!});expect(rest.skipped).toEqual(orphans.slice(1).map(key=>({key,reason:'dry-run'})));
 const real=await collect({startAfter:plan.next!});expect(real.deleted.map(entry=>entry.key)).toEqual(rest.skipped.map(entry=>entry.key));expect(real.kept).toEqual(rest.kept);expect(store.keys(run.root)).toHaveLength(4);
});
it('observes abort before work, during listing and between delete batches, and collects a cancelled journal',async()=>{
 const {store,run,orphans}=await history(),collect=collector(store,run),aborted=new AbortController();aborted.abort();
 expect(await collect({signal:aborted.signal})).toMatchObject({outcome:'aborted',phase:null,pages:0,listed:0,next:run.root,deleted:[],kept:[],skipped:[]});expect(store.events).toEqual([]);
 expect(await collect({signal:aborted.signal,startAfter:orphans[0]!})).toMatchObject({outcome:'aborted',listed:0,next:orphans[0]});
 const listing=new AbortController();store.hooks.list=()=>listing.abort();const partial=await collect({signal:listing.signal,pageSize:2});store.hooks.list=undefined;
 expect(partial).toMatchObject({outcome:'aborted',phase:'finished',pages:1,listed:2,next:run.root,deleted:[],kept:[]});expect(partial.skipped.map(entry=>entry.reason)).toEqual(['aborted','aborted']);expect(store.deletes).toEqual([]);
 const deleting=new AbortController();store.hooks.delete=()=>deleting.abort();const stopped=await collect({signal:deleting.signal,pageSize:1});store.hooks.delete=undefined;
 expect(stopped).toMatchObject({outcome:'aborted',pages:7,listed:7,next:orphans[0]});expect(stopped.deleted).toEqual([{key:orphans[0],reason:'terminal'}]);expect(stopped.skipped).toEqual(orphans.slice(1).map(key=>({key,reason:'aborted'})));expect(store.deletes).toEqual([[orphans[0]]]);
 // Cancellation fences the active owner's uncommitted revision as well.
 const cancelled=storage(),job=await coordinator(cancelled),lease=job.claim(),first=await job.prepare(lease,1);job.commit(lease,first);const staged=await job.prepare(lease,2);job.cancel();
 const report=await collector(cancelled,job)();expect(report).toMatchObject({outcome:'collected',phase:'cancelled'});expect(report.deleted).toEqual([staged.output!.key,staged.state.key].map(key=>({key,reason:'terminal'})));expect(await loadMediaCheckpoint(cancelled.bucket,first)).toEqual({state:Uint8Array.of(1,1),output:Uint8Array.of(1,2,3)});
});
it('rejects resume keys outside the journal prefix before any provider access',async()=>{
 const {store,run}=await history(),collect=collector(store,run),foreign=await coordinator(store,other);
 for(const startAfter of ['final/out.raw','checkpoints/',foreign.root,run.root.slice(0,-1),run.root+'../'+foreign.root.slice('checkpoints/'.length),run.root+'1/./x',run.root+'1\\x',run.root+'\0',run.root+'x'.repeat(1024),7 as unknown as string])await expect(collect({startAfter})).rejects.toThrow(/prefix/);
 expect(store.events).toEqual([]);const resumed=await collect({startAfter:run.root+'2/'});expect(resumed.listed).toBe(3);expect(resumed.deleted.map(entry=>entry.key)).toEqual([run.root+'2/owner2/revision-2/state.bin']);
});
it('resumes a pass from next so keys left by max-deletes or a failed delete are revisited, and reports partial deletions on failure',async()=>{
 const {store,run,orphans,committed}=await history(),collect=collector(store,run),windows:{listed:number;deleted:string[];skipped:string[];next:string|null}[]=[];let after:string|undefined;
 // A window that skips eligible keys resumes before the first of them instead of after the last listed key.
 do{const report=await collect({maxObjects:3,maxDeletes:1,...(after===undefined?{}:{startAfter:after})});windows.push({listed:report.listed,deleted:report.deleted.map(entry=>entry.key),skipped:report.skipped.map(entry=>entry.key+' '+entry.reason),next:report.next});after=report.next??undefined;}while(after!==undefined);
 expect(windows).toEqual([{listed:3,deleted:[orphans[0]],skipped:[],next:orphans[0]},{listed:3,deleted:[orphans[1]],skipped:[orphans[2]+' max-deletes'],next:orphans[1]},{listed:3,deleted:[orphans[2]],skipped:[],next:null}]);expect(store.keys(run.root)).toEqual(committed);
 // A batch that fails after partly applying: nothing is reported deleted, every remaining candidate is `failed`, and a rerun from next completes.
 const partial=await history(),first=collector(partial.store,partial.run);partial.store.hooks.fail=batch=>batch.length===2?1:undefined;
 const error=await failure(first({pageSize:2}));partial.store.hooks.fail=undefined;expect(error.message).toBe('Checkpoint collection stopped after deleting 0 objects: Injected delete failure');expect((error.cause as Error).message).toBe('Injected delete failure');
 expect(error.report).toMatchObject({outcome:'failed',phase:'finished',listed:7,next:partial.committed[1],deleted:[]});expect(error.report.skipped).toEqual(partial.orphans.map(key=>({key,reason:'failed'})));expect(partial.store.keys(partial.run.root)).toEqual([...partial.committed,...partial.orphans.slice(1)].sort());
 const resumed=await first({startAfter:error.report.next!});expect(resumed.deleted).toEqual(partial.orphans.slice(1).map(key=>({key,reason:'terminal'})));expect(partial.store.keys(partial.run.root)).toEqual(partial.committed);
 // A later batch whose acknowledgement is lost: the earlier batch stays reported as deleted.
 const lost=await history(),second=collector(lost.store,lost.run);let calls=0;lost.store.hooks.fail=batch=>++calls===2?batch.length:undefined;
 const ack=await failure(second({pageSize:1}));lost.store.hooks.fail=undefined;expect(ack.report).toMatchObject({outcome:'failed',next:lost.orphans[0]});expect(ack.report.deleted).toEqual([{key:lost.orphans[0],reason:'terminal'}]);expect(ack.report.skipped).toEqual(lost.orphans.slice(1).map(key=>({key,reason:'failed'})));
 const replay=await second({startAfter:ack.report.next!});expect(replay.deleted).toEqual([{key:lost.orphans[2],reason:'terminal'}]);expect(lost.store.keys(lost.run.root)).toEqual(lost.committed);
 // A journal regression at a later pre-delete read keeps the report of the batch already deleted and deletes nothing further.
 const regress=await history(),third=collector(regress.store,regress.run);let reads=0;regress.run.hooks.rewrite=status=>++reads===4?{...status,commits:status.commits.slice(1)}:status;
 const regressed=await failure(third({pageSize:1}));regress.run.hooks.rewrite=undefined;expect(regressed.message).toMatch(/after deleting 1 objects: Checkpoint journal status is inconsistent/);expect(regressed.report.deleted).toEqual([{key:regress.orphans[0],reason:'terminal'}]);expect(regressed.report.skipped).toEqual(regress.orphans.slice(1).map(key=>({key,reason:'failed'})));expect(regress.store.deletes).toEqual([[regress.orphans[0]]]);
 expect((await third({startAfter:regressed.report.next!})).deleted.map(entry=>entry.key)).toEqual(regress.orphans.slice(1));expect(regress.store.keys(regress.run.root)).toEqual(regress.committed);
});
