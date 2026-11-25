// Regenerates per-platform Native corpora for the pinned reference of this host, from the descriptors
// tools/differential-runner/<id>/platform-corpus.json:
//   {"schemaVersion":1,"base":"compat/behavior-specs/<corpus>","generate":"tools/differential-runner/<id>/generate.mjs",
//    "oracle":["<build-oracle name>",...]?,"unprivileged":true|false,"outputs":["cases.json",...]}
// Each generator writes through tools/differential-runner/platform-corpus.mjs; this script builds the oracles it needs,
// runs it and verifies the written manifest and provenance. Committed output comes only from the linux-corpora job of
// .github/workflows/linux-probe.yml on real hardware; elsewhere pass --draft (written under .build/linux-green/drafts/).
//   node tools/linux/generate-corpora.mjs [--draft] [--only id,...|all] [--list]
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {LEGACY_CORPUS_PLATFORM,localReferenceIdentity,loadReferencePins,platformCorpusDirFor} from '../differential-runner/reference-identity.mjs';
import {DRAFT_ENV,DRAFT_ROOT,IMAGE_ENV,ciRecord,committedOriginRefusal,executionEnvironment,verifyPlatformCorpusDir} from '../differential-runner/platform-corpus.mjs';

const root=resolve(import.meta.dirname,'../..'),runners='tools/differential-runner';
process.chdir(root);
const args=process.argv.slice(2),draft=args.includes('--draft'),list=args.includes('--list'),onlyAt=args.indexOf('--only');
const only=onlyAt<0?'all':args[onlyAt+1];
if(args.some((arg,index)=>!['--draft','--list','--only'].includes(arg)&&index!==onlyAt+1)||onlyAt>=0&&(!only||only.startsWith('--'))){console.error('Usage: node tools/linux/generate-corpora.mjs [--draft] [--only id,...|all] [--list]');process.exit(2);}

function readDescriptors(){
 const found=[];
 for(const id of readdirSync(runners).sort()){
  const path=join(runners,id,'platform-corpus.json');if(!existsSync(path))continue;
  const descriptor=JSON.parse(readFileSync(path,'utf8')),oracles=descriptor.oracle===undefined?[]:[descriptor.oracle].flat();
  const valid=descriptor.schemaVersion===1&&typeof descriptor.base==='string'&&descriptor.base.startsWith('compat/behavior-specs/')&&typeof descriptor.generate==='string'&&descriptor.generate.startsWith(`${runners}/${id}/`)&&existsSync(descriptor.generate)
   &&typeof descriptor.unprivileged==='boolean'&&Array.isArray(descriptor.outputs)&&descriptor.outputs.length>0&&descriptor.outputs.every(name=>typeof name==='string'&&/^[\w.-]+$/.test(name)&&!['manifest.json','provenance.json'].includes(name))&&oracles.every(name=>typeof name==='string'&&/^[a-z0-9-]+$/.test(name));
  if(!valid)throw new Error(`${path} is not a schemaVersion 1 platform-corpus descriptor`);
  found.push({id,path,...descriptor,oracles});
 }
 return found;
}

const descriptors=readDescriptors();
if(list){for(const item of descriptors)console.log(`${item.id}\t${item.base}\t${item.generate}${item.unprivileged?'\tunprivileged':''}`);process.exit(0);}
if(!descriptors.length)throw new Error(`No platform-corpus descriptors (${runners}/*/platform-corpus.json); nothing can be generated`);
const selected=only==='all'?descriptors:only.split(',').map(id=>descriptors.find(item=>item.id===id)??(()=>{throw new Error(`Unknown platform-corpus descriptor ${id}; known: ${descriptors.map(item=>item.id).join(', ')}`);})());
const identity=localReferenceIdentity(root),pins=loadReferencePins(root),environment=executionEnvironment();
if(identity.id===LEGACY_CORPUS_PLATFORM&&!draft)throw new Error(`${LEGACY_CORPUS_PLATFORM} corpora keep their tracked layout; regenerate them with each generator's own command`);
if(!draft){const refusal=committedOriginRefusal({id:identity.id,tracked:`${identity.id} corpora`,environment,ci:ciRecord(),image:process.env[IMAGE_ENV]??null,pinImage:identity.pin.image??null});if(refusal)throw new Error(refusal);}
console.log(`[linux-corpora] reference ${identity.id} ffmpeg ${identity.ffmpeg.slice(0,12)} on ${environment.cpuModel} (uid ${environment.uid})${draft?', drafts under '+DRAFT_ROOT:''}`);

const summary={reference:identity.id,ffmpeg:identity.ffmpeg,draft,environment,startedAt:new Date().toISOString(),corpora:[]};
const run=(file,argv,env={})=>{const result=spawnSync(file,argv,{cwd:root,stdio:'inherit',env:{...process.env,...env}});if(result.error||result.status!==0)throw new Error(`${[file,...argv].join(' ')} failed (${result.error?.message??result.signal??'exit '+result.status})`);};
let failure=null;
for(const item of selected){
 const started=Date.now();
 try{
  if(item.unprivileged&&!environment.unprivileged)throw new Error(`${item.id} must run as an unprivileged user (uid ${environment.uid})`);
  for(const oracle of item.oracles)run(process.execPath,[`${runners}/build-oracle.mjs`,oracle]);
  run(process.execPath,[item.generate,...(draft?['--draft']:[])],draft?{[DRAFT_ENV]:'1'}:{});
  const dir=draft?join(DRAFT_ROOT,platformCorpusDirFor(item.base,identity.id,pins)):platformCorpusDirFor(item.base,identity.id,pins);
  const provenance=verifyPlatformCorpusDir(dir,identity.id,{root,pins,allowDraft:draft});
  const written=readdirSync(dir).filter(name=>!['manifest.json','provenance.json'].includes(name)).sort();
  if(JSON.stringify(written)!==JSON.stringify([...item.outputs].sort()))throw new Error(`${item.id} wrote ${written.join(', ')}, its descriptor declares ${item.outputs.join(', ')}`);
  if(provenance.generator.path!==item.generate)throw new Error(`${item.id} provenance names generator ${provenance.generator.path}`);
  summary.corpora.push({id:item.id,dir,status:'generated',seconds:(Date.now()-started)/1000,files:written});
  console.log(`[linux-corpora] ${item.id}: ${dir} (${written.join(', ')})`);
 }catch(error){summary.corpora.push({id:item.id,status:'failed',seconds:(Date.now()-started)/1000,error:error.message});console.error(`[linux-corpora] ${item.id} failed: ${error.message}`);failure??=error;}
}
summary.finishedAt=new Date().toISOString();
mkdirSync('.build/linux-corpora',{recursive:true});writeFileSync('.build/linux-corpora/summary.json',JSON.stringify(summary,null,2)+'\n');
if(failure){console.error(`[linux-corpora] ${summary.corpora.filter(item=>item.status==='failed').length} of ${selected.length} corpora failed; see .build/linux-corpora/summary.json`);process.exit(1);}
