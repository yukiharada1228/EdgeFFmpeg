// Runs one shard of a suite and records it for compat:report --from-shards (docs/contributing/ci.md).
//   node tools/ci/shard.mjs --suite <unit|integration|differential|workers> --index <i> --out <dir> [--plan <file>] [--prepare]
// The shard's files come from the plan: --plan, else the EDGEFFMPEG_CI_PLAN environment variable (the plan job's
// output), else the full plan of this checkout. A full plan given from outside must equal the one this checkout
// computes. The files run in one Vitest process with exactly the options of the suite's npm script
// (tools/linux/probe.mjs suiteOptions), plus the JSON reporter compat:report reads.
// --prepare first runs `npm run reference:extract`, which rewrites the tracked compat/capabilities.json, so the tests see
// the same tree as in a serial compat:report run; validate:fast runs it once before starting its shards instead.
// The shard records source and reference snapshots before and after the run; the aggregate requires both to equal its
// own. Outputs in <dir>: <suite>-<i>.json (Vitest JSON), <suite>-<i>.log and <suite>-<i>.shard.json (this record).
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {snapshotSource,snapshotReference,sha256} from '../compatibility-report/source.mjs';
import {runPlatform} from '../compatibility-report/summarize.mjs';
import {suiteOptions} from '../linux/probe.mjs';
import {SHARD_KIND} from '../compatibility-report/shards.mjs';
import {SUITES,fullPlan,validatePlan} from './plan.mjs';

const root=resolve(import.meta.dirname,'../..');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
function referenceState(){
 try{return {snapshot:snapshotReference(root),metadata:readJson(resolve(root,'.build/reference/build-metadata.json'))};}catch{return {snapshot:null,metadata:null};}
}
/** The plan a shard runs: an explicit plan (validated; a full one must equal this checkout's), else the full plan. */
export function shardPlan({planFile=null,planJson=process.env.EDGEFFMPEG_CI_PLAN??null,files}){
 const local=fullPlan(files);
 const given=planFile?readJson(planFile):planJson?JSON.parse(planJson):null;
 if(!given)return local;
 validatePlan(given);
 if(given.mode==='full'&&given.sha256!==local.sha256)throw new Error(`The given full plan ${given.sha256.slice(0,12)} differs from this checkout's ${local.sha256.slice(0,12)}`);
 return given;
}
function tee(command,args,logPath){
 return new Promise(done=>{
  const log=createWriteStream(logPath),child=spawn(command,args,{cwd:root,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{process.stdout.write(chunk);log.write(chunk);});
  child.stderr.on('data',chunk=>{process.stderr.write(chunk);log.write(chunk);});
  child.on('error',error=>log.write(`\n${error.message}\n`));
  child.on('close',(code,signal)=>log.end(()=>done({exitCode:code,signal})));
 });
}
export async function runShard({suite,index,out,planFile=null,prepare=false}){
 if(!SUITES.includes(suite)||!Number.isInteger(index)||index<1)throw new Error(`Invalid shard ${suite} ${index}`);
 const id=`${suite}-${index}`,report=resolve(out,`${id}.json`),logPath=resolve(out,`${id}.log`),record=resolve(out,`${id}.shard.json`);
 mkdirSync(out,{recursive:true});for(const path of [report,logPath,record,resolve(out,`${id}.prepare.log`)])rmSync(path,{force:true});
 let preparation=null;
 if(prepare){
  const started=Date.now(),result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['run','reference:extract'],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
  const text=`${result.stdout??''}${result.stderr??''}${result.error?'\n'+result.error.message:''}`;writeFileSync(resolve(out,`${id}.prepare.log`),text);
  preparation={command:['npm','run','reference:extract'],status:result.status===0&&!result.error?'passed':'failed',exitCode:result.status,durationMs:Date.now()-started,log:`${id}.prepare.log`,logSha256:sha256(text)};
  console.log(`[shard ${id}] reference:extract: ${preparation.status}`);
 }
 const before=snapshotSource(root),referenceBefore=referenceState();
 const plan=shardPlan({planFile,files:before.files.map(entry=>entry.file)}),shards=plan.suites[suite]??[],files=shards[index-1];
 if(!files?.length)throw new Error(`Plan ${plan.sha256.slice(0,12)} has no shard ${id} (it has ${shards.length} ${suite} shards)`);
 const args=['vitest','run',...files,...suiteOptions(suite),'--reporter=default','--reporter=json',`--outputFile=${report}`];
 console.log(`[shard ${id}] ${files.length} files of plan ${plan.mode} ${plan.sha256.slice(0,12)}: npx vitest run <files> ${suiteOptions(suite).join(' ')}`);
 const startedAt=new Date().toISOString(),started=Date.now(),result=await tee(process.platform==='win32'?'npx.cmd':'npx',args,logPath),durationMs=Date.now()-started;
 const after=snapshotSource(root),referenceAfter=referenceState(),log=readFileSync(logPath);
 const meta={schemaVersion:1,kind:SHARD_KIND,id,suite,index,count:shards.length,planMode:plan.mode,planSha256:plan.sha256,files,
  command:['npx',...args.slice(0,-1),`--outputFile=${id}.json`],exitCode:result.exitCode,signal:result.signal,startedAt,finishedAt:new Date().toISOString(),durationMs,
  log:`${id}.log`,logSha256:sha256(log),report:existsSync(report)?`${id}.json`:null,reportSha256:existsSync(report)?sha256(readFileSync(report)):null,
  root,revision:before.revision,sourceBefore:before.sha256,sourceAfter:after.sha256,referenceBefore:referenceBefore.snapshot,referenceAfter:referenceAfter.snapshot,
  platform:runPlatform(process,referenceBefore.metadata),environment:{node:process.version,platform:process.platform,arch:process.arch},preparation,
  ci:process.env.GITHUB_ACTIONS==='true'?{runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null,job:process.env.GITHUB_JOB??null,sha:process.env.GITHUB_SHA??null,ref:process.env.GITHUB_REF??null}:null};
 writeFileSync(record,JSON.stringify(meta,null,1)+'\n');
 const stable=before.sha256===after.sha256&&JSON.stringify(referenceBefore.snapshot)===JSON.stringify(referenceAfter.snapshot);
 const passed=result.exitCode===0&&!result.signal&&meta.report!==null&&stable&&(preparation===null||preparation.status==='passed');
 console.log(`[shard ${id}] ${passed?'passed':'failed'}: exit ${result.exitCode}${result.signal?` (${result.signal})`:''}, ${(durationMs/1000).toFixed(1)} s, source ${stable?'stable':'changed'}; record ${relative(root,record)}`);
 return {meta,passed};
}

if(import.meta.url===`file://${process.argv[1]}`){
 const args=process.argv.slice(2),option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]??null;};
 const suite=option('--suite'),index=Number(option('--index')),out=option('--out');
 if(!suite||!out||!Number.isInteger(index)){console.error('Usage: node tools/ci/shard.mjs --suite <suite> --index <i> --out <dir> [--plan <file>] [--prepare]');process.exit(2);}
 const {passed}=await runShard({suite,index,out:resolve(process.env.INIT_CWD??process.cwd(),out),planFile:option('--plan')?resolve(process.env.INIT_CWD??process.cwd(),option('--plan')):null,prepare:args.includes('--prepare')});
 process.exitCode=passed?0:1;
}
