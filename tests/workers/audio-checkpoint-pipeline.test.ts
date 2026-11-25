import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {MediaCheckpointCollectionReport,MediaCheckpointDescriptor,MediaCheckpointLease,MediaCheckpointStatus,MediaCheckpointWorkflowManifest,MediaCheckpointWorkflowSpec} from '@edge-ffmpeg/runtime-cloudflare/checkpoints';
import type {AudioCheckpointPipelineConfig,AudioCheckpointPipelineStage} from '@edge-ffmpeg/avformat';
import {pinnedReference} from '../helpers/reference-identity.js';
type Instance={status:string;output?:MediaCheckpointWorkflowManifest|null;error?:{message:string}|null;__LOCAL_DEV_STEP_OUTPUTS?:unknown[]};
type Codec='pcm_s16le'|'pcm_f32le';
type Case={readonly name:string;readonly inputRate:number;readonly outputRate:number;readonly channels:number;readonly input:Codec;readonly precision:'s16'|'flt';readonly codec:Codec;readonly stage:AudioCheckpointPipelineStage;readonly samples:number;readonly unitSamples:number;readonly bitexact:boolean};
type Spec={spec:MediaCheckpointWorkflowSpec;plan:{units:number;unitBytes:number;stateBytes:number;outputBytes:string;error?:string}};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),raw={pcm_s16le:'s16le',pcm_f32le:'f32le'} as const,widths={pcm_s16le:2,pcm_f32le:4} as const;
// Small frames let resampled output reach the mux every few units instead of as one pending frame at EOF.
const limits={maxFrameBytes:512,maxStateBytes:1<<20,maxReadBytes:1024,maxUnitBytes:16384,maxUnits:256};
const filter=(stage:AudioCheckpointPipelineStage)=>stage.filter==='asetnsamples'?`asetnsamples=n=${stage.samples}:p=${Number(stage.pad)}`:`apad=${stage.mode}=${stage.mode.endsWith('_dur')?String(Number(stage.limit)/1e6):stage.limit}`;
const configOf=(c:Case):AudioCheckpointPipelineConfig=>({outputRate:c.outputRate,precision:c.precision,codec:c.codec,bitexact:c.bitexact,stage:c.stage,unitSamples:c.unitSamples,limits});
// The restart case first; the others run concurrently without faults. Inputs exceed maxReadBytes, so every unit is a ranged read.
const cases:readonly Case[]=[
 {name:'restart',inputRate:44100,outputRate:48000,channels:2,input:'pcm_s16le',precision:'s16',codec:'pcm_s16le',stage:{filter:'asetnsamples',samples:64,pad:true},samples:600,unitSamples:40,bitexact:false},
 {name:'down-apad',inputRate:48000,outputRate:8000,channels:1,input:'pcm_s16le',precision:'s16',codec:'pcm_s16le',stage:{filter:'apad',mode:'pad_len',limit:'77',packetSamples:10,packetsPerUnit:2},samples:900,unitSamples:64,bitexact:true},
 {name:'float-fifo',inputRate:8000,outputRate:11025,channels:2,input:'pcm_f32le',precision:'flt',codec:'pcm_f32le',stage:{filter:'asetnsamples',samples:5,pad:false},samples:301,unitSamples:29,bitexact:false},
 {name:'interp-3ch',inputRate:44100,outputRate:48001,channels:3,input:'pcm_s16le',precision:'s16',codec:'pcm_s16le',stage:{filter:'asetnsamples',samples:7,pad:true},samples:301,unitSamples:29,bitexact:false},
 {name:'float-whole',inputRate:22050,outputRate:44100,channels:2,input:'pcm_s16le',precision:'flt',codec:'pcm_s16le',stage:{filter:'apad',mode:'whole_len',limit:'900',packetSamples:64,packetsPerUnit:1},samples:301,unitSamples:64,bitexact:true},
 // No rate change: native ignores tsf=s16p and copies the f32 samples, so the narrower precision must not quantize them.
 {name:'equal-rate',inputRate:16000,outputRate:16000,channels:2,input:'pcm_f32le',precision:'s16',codec:'pcm_f32le',stage:{filter:'asetnsamples',samples:5,pad:false},samples:301,unitSamples:29,bitexact:false},
];
function samples(c:Case):Buffer{
 const bytes=Buffer.alloc(c.samples*c.channels*widths[c.input]);
 for(let i=0;i<c.samples;i++)for(let k=0;k<c.channels;k++){const at=i*c.channels+k;if(c.input==='pcm_s16le')bytes.writeInt16LE(((at*3137+k*911)%65536)-32768,at*2);else bytes.writeFloatLE(.6*Math.sin(i*.0731*(k+1))+.3*Math.cos(i*.53+k),at*4);}
 return bytes;
}
it('runs a ranged WAV -> aresample -> asetnsamples/apad -> WAV mux pipeline through actual Workflows across a full runtime restart, a dropped commit acknowledgement and a stale owner, then collects orphans and still finalizes Native-identical WAV, and refuses tagged or over-budget inputs before any unit',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'edge-audio-checkpoint-pipeline-')),root=resolve('tests/workers'),binary=resolve('.build/reference/ffmpeg');expect(sha(readFileSync(binary))).toBe(pinnedReference().ffmpeg);
 const bundle=await build({entryPoints:[root+'/audio-checkpoint-pipeline-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],metafile:true});for(const path of Object.keys(bundle.metafile!.inputs))expect(path.startsWith('node:')).toBe(false);
 const start=()=>new Miniflare(convertV4MiniflareOptions({name:'audio-checkpoint-pipeline-test',modules:[{type:'ESModule',path:root+'/audio-checkpoint-pipeline-bundle.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],resourcePersistencePath:join(directory,'persist'),durableObjects:{CHECKPOINTS:{className:'PipelineCheckpointCoordinator',useSQLite:true}},r2Buckets:['MEDIA_BUCKET'],workflows:{CHECKPOINT_WORKFLOW:{name:'audio-checkpoint-pipeline-local',className:'AudioPipelineCheckpointWorkflow'}}}));let mf=start();
 const call=async<T>(path:string,body?:unknown,status=200):Promise<T>=>{const response=await mf.dispatchFetch('https://pipeline.test'+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),value=await response.json() as T;expect(response.status,JSON.stringify(value)).toBe(status);return value;};
 const instance=(id:string)=>call<Instance>('/status?id='+id),journal=(spec:MediaCheckpointWorkflowSpec)=>call<MediaCheckpointStatus>('/journal',{spec});
 const wait=async(id:string,phase:string,timeout=90000)=>{const end=Date.now()+timeout;for(;;){const value=await instance(id);if(value.status===phase)return value;if(['errored','terminated','complete'].includes(value.status))throw Error('Unexpected workflow status '+JSON.stringify(value));if(Date.now()>end)throw Error('Workflow timeout '+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,25));}};
 const until=async(spec:MediaCheckpointWorkflowSpec,revision:number)=>{for(const end=Date.now()+60000;(await journal(spec)).revision<revision;){if(Date.now()>end)throw Error('No committed progress');await new Promise(resolve=>setTimeout(resolve,20));}};
 let bucket=await(async()=>{await mf.ready;return mf.getR2Bucket('MEDIA_BUCKET');})();
 const restart=async()=>{await mf.dispose();mf=start();await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');};
 const bytes=async(key:string)=>Buffer.from(await(await bucket.get(key))!.arrayBuffer()),keys=async(prefix:string)=>(await bucket.list({prefix})).objects.map(object=>object.key).sort();
 // Namespace names hash [jobId, workUnitId]; attempt objects live beneath it.
 const prefix=(job:string)=>'checkpoints/checkpoint-'+createHash('sha256').update(JSON.stringify([job,'audio'])).digest('hex')+'/';
 const referenced=(status:MediaCheckpointStatus)=>status.commits.flatMap(commit=>[commit.state.key,...(commit.output?[commit.output.key]:[])]).sort();
 try{
  // Native-written inputs and the pinned Native commands the pipeline continues.
  const natives=new Map<string,Buffer>();
  for(const c of cases){
   writeFileSync(join(directory,c.name+'.raw'),samples(c));execFileSync(binary,['-v','error','-y','-f',raw[c.input],'-ar',String(c.inputRate),'-ac',String(c.channels),'-i',join(directory,c.name+'.raw'),'-c:a',c.input,'-bitexact',join(directory,c.name+'.wav')]);
   const tsf=c.precision==='s16'?':tsf=s16p':'';execFileSync(binary,['-v','error','-y','-cpuflags','0','-i',join(directory,c.name+'.wav'),'-af',`aresample=${c.outputRate}${tsf},${filter(c.stage)}`,'-c:a',c.codec,...(c.bitexact?['-bitexact']:[]),join(directory,c.name+'-native.wav')],{timeout:15000,stdio:'pipe'});
   const input=readFileSync(join(directory,c.name+'.wav'));expect(input.length).toBeGreaterThan(limits.maxReadBytes);await bucket.put('inputs/'+c.name+'.wav',input);natives.set(c.name,readFileSync(join(directory,c.name+'-native.wav')));
  }
  const main=cases[0]!,native=natives.get(main.name)!,job='pipeline-restart';
  const {spec,plan}=await call<Spec>('/spec',{id:job,jobId:job,input:'inputs/restart.wav',path:'/output/restart.wav',pipeline:configOf(main),unitsPerInvocation:2,leaseMs:3000,delayMs:250,dropAck:3});
  expect(plan).toMatchObject({units:15,outputBytes:String(native.length)});expect(plan.unitBytes).toBeLessThanOrEqual(limits.maxUnitBytes);expect(plan.stateBytes).toBeLessThanOrEqual(65536);
  // A stale owner claims first and stages revision 1 under generation 1, then its lease runs out before it commits.
  const stale=await call<{lease:MediaCheckpointLease;descriptor:MediaCheckpointDescriptor}>('/stale-prepare?leaseMs=1500',{spec});expect(stale.lease.generation).toBe(1);expect(stale.descriptor).toMatchObject({revision:1,inputPosition:'40',finished:false});
  const staleKeys=[stale.descriptor.state.key,stale.descriptor.output!.key].sort();for(const key of staleKeys)expect(await bucket.head(key)).not.toBeNull();
  await call('/start',{spec});
  // The instance waits out the stale lease and claims generation 2; the stale owner's late commit is then refused.
  await until(spec,1);const claimed=await journal(spec);expect(claimed.lease!.generation).toBeGreaterThanOrEqual(2);
  const refused=await call<{ok:boolean;error?:string}>('/stale-commit',{spec,lease:stale.lease,descriptor:stale.descriptor});expect(refused).toMatchObject({ok:false});expect(refused.error).toMatch(/stale committer|Stale checkpoint lease/);
  // Revision 3 commits but its acknowledgement is lost; the runner replays the identical descriptor. Then the whole runtime is destroyed mid-run.
  await until(spec,5);expect((await bytes('faults/'+job+'/dropped')).toString()).toBe('3');
  await restart();const interrupted=await journal(spec);expect(interrupted.revision).toBeGreaterThanOrEqual(5);expect(interrupted.revision).toBeLessThan(15);
  // Local Workflows schedules no wake-up after a process restart, so the persisted instance is reactivated explicitly.
  expect((await instance(job)).status).toBe('running');await call('/pause?id='+job);await wait(job,'paused');await call('/resume?id='+job);
  const done=await wait(job,'complete'),manifest=done.output!,finished=await journal(spec);
  expect(finished).toMatchObject({phase:'finished',lease:null,revision:15,inputPosition:'600',outputPosition:String(native.length)});expect(finished.commits.map(commit=>commit.revision)).toEqual(Array.from({length:15},(_,index)=>index+1));
  expect(finished.commits.slice(0,interrupted.revision)).toEqual(interrupted.commits);expect(await bytes('faults/'+job+'/replayed-3')).toEqual(Buffer.from('1'));
  const owner=(commit:{state:{key:string}})=>commit.state.key.split('/').slice(2,4).join('/'),generations=finished.commits.map(commit=>Number(commit.state.key.split('/')[2]));
  expect(generations).toEqual([...generations].sort((a,b)=>a-b));expect(generations[0]).toBeGreaterThanOrEqual(2);expect(new Set(finished.commits.map(owner)).size).toBe(new Set(generations).size);expect(finished.commits.some(commit=>commit.state.key.includes('/'+stale.lease.token+'/'))).toBe(false);
  // Every unit step ran at most two units; the instance yielded several times between them.
  const steps=(done.__LOCAL_DEV_STEP_OUTPUTS??[]) as {outcome?:string;units?:number}[];expect(steps.filter(step=>step.outcome==='yielded').length).toBeGreaterThanOrEqual(5);expect(steps.every(step=>step.outcome!=='yielded'||step.units!<=2)).toBe(true);expect(steps.some(step=>step.outcome==='busy')).toBe(true);
  expect(await bytes('final/restart.wav')).toEqual(native);expect(manifest).toMatchObject({workflowId:job,bytes:String(native.length),outputSha256:sha(native),revisions:15});expect(await keys('final-stage/')).toEqual([]);
  // Orphan collection removes exactly the unreferenced attempt objects (the stale owner's and any staged by the destroyed runtime).
  const before=await keys(prefix(job)),committed=referenced(finished),orphans=before.filter(key=>!committed.includes(key));for(const key of staleKeys)expect(orphans).toContain(key);
  const report=await call<MediaCheckpointCollectionReport>('/collect',{spec});expect(report).toMatchObject({outcome:'collected',phase:'finished',next:null,skipped:[]});
  expect(report.deleted).toEqual(orphans.map(key=>({key,reason:'terminal'})));expect(report.kept.map(entry=>entry.key).sort()).toEqual(committed);expect(report.kept.every(entry=>entry.reason==='committed')).toBe(true);expect(await keys(prefix(job))).toEqual(committed);
  // Committed states still verify and chain to their positions; the unpatched stream differs from Native only in the trailer fields.
  const loaded=await mf.dispatchFetch('https://pipeline.test/load',{method:'POST',body:JSON.stringify({spec})});expect(loaded.status).toBe(200);const stream=Buffer.from(await loaded.arrayBuffer()),dataSize=native.indexOf('data')+4;expect(stream.length).toBe(native.length);
  const rewritten=new Set([4,5,6,7,dataSize,dataSize+1,dataSize+2,dataSize+3]);for(let at=0;at<native.length;at++)if(stream[at]!==native[at])expect(rewritten.has(at),'byte '+at).toBe(true);expect(stream.readUInt32LE(4)).toBe(0xffffffff);
  // Finalization still succeeds after collection: direct publication re-verifies the destination, a new path assembles Native bytes, a replay verifies.
  const version=(await bucket.head('final/restart.wav'))!.version;expect(await call('/publish',{spec})).toEqual(manifest);
  const chunks=finished.commits.filter(commit=>commit.output!==null).length;expect(chunks).toBeGreaterThanOrEqual(5);
  expect(await call('/finalize?path=/output/restart-again.wav',{spec})).toEqual({bytes:String(native.length),revisions:15,outputChunks:chunks,existing:false});expect(await bytes('final/restart-again.wav')).toEqual(native);
  expect(await call('/finalize?path=/output/restart.wav',{spec})).toMatchObject({existing:true});expect((await bucket.head('final/restart.wav'))!.version).toBe(version);
  expect((await call<{ok:boolean;error?:string}>('/stale-commit',{spec,lease:stale.lease,descriptor:stale.descriptor})).ok).toBe(false);expect(await journal(spec)).toEqual(finished);

  // The other profiles through the same Workflow, three units per step, without faults: Native bytes, no orphans.
  const runs=await Promise.all(cases.slice(1).map(async c=>{const value=await call<Spec>('/spec',{id:'pipeline-'+c.name,jobId:'pipeline-'+c.name,input:'inputs/'+c.name+'.wav',path:'/output/'+c.name+'.wav',pipeline:configOf(c),unitsPerInvocation:3,leaseMs:3000});await call('/start',{spec:value.spec});return {c,...value};}));
  for(const {c,spec:other,plan:planned}of runs){
   const output=await wait('pipeline-'+c.name,'complete'),status=await journal(other),expected=natives.get(c.name)!;
   expect(await bytes('final/'+c.name+'.wav'),c.name).toEqual(expected);expect(planned.outputBytes).toBe(String(expected.length));expect(status).toMatchObject({phase:'finished',revision:planned.units,outputPosition:String(expected.length)});expect(output.output).toMatchObject({outputSha256:sha(expected)});
   expect((await call<MediaCheckpointCollectionReport>('/collect',{spec:other})).deleted).toEqual([]);expect(await keys(prefix('pipeline-'+c.name))).toEqual(referenced(status));
  }
  // apad drains its silence over later units (15+3 and 5+4); the FIFO cases need only their input units.
  expect(runs.map(run=>run.plan.units)).toEqual([18,11,11,9,11]);
  const equal=natives.get('equal-rate')!,source=readFileSync(join(directory,'equal-rate.wav'));expect(equal.subarray(equal.indexOf('data')+8)).toEqual(source.subarray(source.indexOf('data')+8));

  // Deterministic refusals: the binding's inspect fails the validation step (no retries) before any journal or checkpoint object exists.
  writeFileSync(join(directory,'tagged.raw'),samples(main));execFileSync(binary,['-v','error','-y','-f','s16le','-ar','44100','-ac','2','-i',join(directory,'tagged.raw'),'-c:a','pcm_s16le','-metadata','title=Hello','-bitexact',join(directory,'tagged.wav')]);
  await bucket.put('inputs/tagged.wav',readFileSync(join(directory,'tagged.wav')));
  const refusals=[{id:'pipeline-tagged',input:'inputs/tagged.wav',pipeline:configOf(main),error:/metadata "INAM" is not implemented: the pipeline does not carry input metadata into the output/},{id:'pipeline-budget',input:'inputs/restart.wav',pipeline:{...configOf(main),unitSamples:2,limits:{...limits,maxUnits:65536}},error:/needs 300 units; the journal holds 256 revisions/}];
  for(const {id,input,pipeline,error}of refusals){
   const refused=await call<Spec>('/spec',{id,jobId:id,input,path:'/output/'+id+'.wav',pipeline,unitsPerInvocation:3,leaseMs:3000});expect(refused.plan.error).toMatch(error);
   await call('/start',{spec:refused.spec});const failed=await wait(id,'errored');expect(failed.error!.message,id).toMatch(error);expect(await keys(prefix(id))).toEqual([]);expect(await keys('final/'+id)).toEqual([]);
  }
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
},240000);
