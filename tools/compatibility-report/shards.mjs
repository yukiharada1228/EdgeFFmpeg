// Shard evidence for compat:report --from-shards (docs/contributing/ci.md). A suite's evidence is accepted only when
// every shard of the plan is present exactly once, each shard ran exactly its planned files with its suite's command
// on the same source, reference, platform and Node as the aggregate, its --prepare step (when it had one) passed, its
// record is complete and consistent with the other shards, and its Vitest JSON, log and test outputs are intact.
// Missing, empty, partial, duplicated, unexpected, inconsistent or altered shards make the suite invalid evidence, so
// validation fails; they are never skipped.
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,posix,resolve,relative} from 'node:path';
import {sha256} from './source.mjs';
import {summarizeSuite} from './summarize.mjs';
import {suiteOptions} from '../linux/probe.mjs';

export const SHARD_KIND='edgeffmpeg-test-shard';
// Where a serial compat:report run's evidence upload would carry a file a test writes; a shard keeps such files.
export const OUTPUT_ROOTS=Object.freeze(['compat/reports','.build/evidence','.build/fate-execution']);
export const PREPARE_COMMAND=Object.freeze(['npm','run','reference:extract']);
const SHARD_RECORD=/^(unit|integration|differential|workers)-([1-9]\d*)\.shard\.json$/,DIGEST=/^[0-9a-f]{64}$/;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const isTime=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value));

/** The command a shard records: its files with exactly the options of the suite's npm script and the JSON reporter. */
export function shardCommand(suite,files,id,scripts){
 return ['npx','vitest','run',...files,...(scripts?suiteOptions(suite,scripts):suiteOptions(suite)),'--reporter=default','--reporter=json',`--outputFile=${id}.json`];
}
/** A test output path: relative, normalized and under OUTPUT_ROOTS. */
export function outputPath(path){
 return typeof path==='string'&&!isAbsolute(path)&&posix.normalize(path)===path&&!path.split('/').includes('..')&&OUTPUT_ROOTS.some(rootPath=>path.startsWith(rootPath+'/'));
}
/** Shard records of a directory by id. Any other *.shard.json, or a record naming another id, is an error. */
export function readShardDirectory(directory){
 if(!existsSync(directory))throw new Error(`Shard directory ${directory} does not exist`);
 const shards=new Map();
 for(const name of readdirSync(directory).filter(name=>name.endsWith('.shard.json')).sort()){
  const match=SHARD_RECORD.exec(name);if(!match)throw new Error(`Unexpected shard record ${name}`);
  let meta;try{meta=JSON.parse(readFileSync(resolve(directory,name),'utf8'));}catch(error){throw new Error(`Unreadable shard record ${name}: ${error.message}`);}
  if(meta?.kind!==SHARD_KIND||meta.schemaVersion!==1||meta.id!==name.slice(0,-'.shard.json'.length)||meta.suite!==match[1]||meta.index!==Number(match[2]))throw new Error(`Invalid shard record ${name}`);
  shards.set(meta.id,meta);
 }
 return shards;
}
/**
 * Checks that hold across every shard record of a run, whatever its suite: one revision (the aggregate's), one CI run
 * (or none) whose commit is that revision, and the same preparation for every shard (all ran --prepare or none did).
 * Attempts of one run may differ: re-running a failed shard job runs the same plan on the same commit, and each record
 * is still checked against the plan, the source and the reference on its own. Returns the problems; any problem makes
 * every suite invalid evidence.
 */
export function checkShardSet(shards,{revision}){
 const records=[...shards.values()],problems=[];
 if(!records.length)return problems;
 const revisions=[...new Set(records.map(meta=>meta.revision))];
 if(revisions.length!==1||revisions[0]!==revision)problems.push(`the shards ran on revisions ${revisions.join(', ')}, not ${revision}`);
 const runs=[...new Set(records.map(meta=>JSON.stringify(meta.ci===null||meta.ci===undefined?null:{runId:meta.ci.runId,sha:meta.ci.sha})))];
 if(runs.length!==1)problems.push(`the shard records come from ${runs.length} different CI runs or mix CI and local runs`);
 for(const meta of records)if(meta.ci&&meta.ci.sha!==meta.revision)problems.push(`shard ${meta.id} records CI commit ${meta.ci.sha} for revision ${meta.revision}`);
 const prepared=new Set(records.map(meta=>meta.preparation===null||meta.preparation===undefined?'without':'with'));
 if(prepared.size!==1)problems.push('some shards ran --prepare and some did not');
 return problems;
}
/** Vitest JSON names files by absolute path; a shard that ran in another checkout path is rebased onto this root. */
function rebase(raw,shardRoot,root){
 if(!Array.isArray(raw?.testResults)||typeof shardRoot!=='string'||shardRoot===root)return raw;
 return {...raw,testResults:raw.testResults.map(entry=>typeof entry?.name==='string'&&entry.name.startsWith(shardRoot+'/')?{...entry,name:root+entry.name.slice(shardRoot.length)}:entry)};
}
/** Problems with the fields of one shard record that do not depend on the other shards. */
function recordProblems(meta,{id,suite,files,scripts}){
 const problems=[];
 let expected=null;try{expected=shardCommand(suite,files,id,scripts);}catch(error){problems.push(`its suite command cannot be derived: ${error.message}`);}
 if(expected&&!same(meta.command,expected))problems.push(`its command is not the ${suite} suite's: ${JSON.stringify(meta.command)?.slice(0,200)}`);
 if(!(meta.exitCode===null||Number.isInteger(meta.exitCode))||!(meta.signal===null||typeof meta.signal==='string')||meta.exitCode===null&&meta.signal===null)problems.push(`it records exit ${JSON.stringify(meta.exitCode)} and signal ${JSON.stringify(meta.signal)}`);
 if(!isTime(meta.startedAt)||!isTime(meta.finishedAt)||Date.parse(meta.finishedAt)<Date.parse(meta.startedAt))problems.push(`it records the times ${JSON.stringify(meta.startedAt)} to ${JSON.stringify(meta.finishedAt)}`);
 else if(!Number.isFinite(meta.durationMs)||meta.durationMs<0||meta.durationMs>Date.parse(meta.finishedAt)-Date.parse(meta.startedAt)+1000)problems.push(`its duration ${JSON.stringify(meta.durationMs)} ms does not fit its start and finish`);
 if(meta.log!==`${id}.log`||!DIGEST.test(String(meta.logSha256)))problems.push('its log is not recorded as <id>.log with a sha256');
 if(meta.report!==null&&(meta.report!==`${id}.json`||!DIGEST.test(String(meta.reportSha256))))problems.push('its Vitest JSON is not recorded as <id>.json with a sha256');
 if(typeof meta.root!=='string'||!isAbsolute(meta.root))problems.push('it records no absolute checkout root');
 for(const key of ['sourceBefore','sourceAfter'])if(!DIGEST.test(String(meta[key])))problems.push(`it records no ${key} snapshot`);
 if(!Array.isArray(meta.outputs))problems.push('it records no list of test outputs');
 if(meta.preparation!==null&&meta.preparation!==undefined){
  const preparation=meta.preparation;
  if(!same(preparation.command,PREPARE_COMMAND))problems.push(`its preparation is ${JSON.stringify(preparation.command)}, not ${PREPARE_COMMAND.join(' ')}`);
  if(preparation.status!=='passed'||preparation.exitCode!==0)problems.push(`its --prepare step (${PREPARE_COMMAND.join(' ')}) failed: status ${preparation.status}, exit ${preparation.exitCode}`);
  if(preparation.log!==`${id}.prepare.log`||!DIGEST.test(String(preparation.logSha256)))problems.push('its preparation log is not recorded as <id>.prepare.log with a sha256');
 }
 return problems;
}
/**
 * Evidence of one suite from its shards. context: {root, directory, evidence, plan, expected, policy, before,
 * referenceBefore, platform, outputs?, scripts?}. outputs: a Map shared by every suite of one aggregate that collects
 * the test outputs (restoreOutputs writes them). Returns {gate, suite, sourceStable, referenceStable}: the
 * tests-<suite> gate (passed only when every planned shard prepared and exited 0) and the suite summary of the merged
 * Vitest results, or invalid-evidence.
 */
export function collectSuite(name,shards,context){
 const {root,directory,evidence,plan,expected,policy,before,referenceBefore,platform,outputs=new Map(),scripts}=context;
 const planned=plan.suites[name]??[],problems=[],records=[],results=[];let sourceStable=true,referenceStable=true;
 mkdirSync(resolve(evidence,'shards'),{recursive:true});
 if(!planned.length)problems.push(`the plan has no ${name} shard (no test files)`);
 if(!same([...planned.flat()].sort(),[...expected].sort()))problems.push(`the plan does not assign every ${name} test file to exactly one shard`);
 for(const id of shards.keys())if(id.startsWith(`${name}-`)&&!planned.some((_,position)=>id===`${name}-${position+1}`))problems.push(`unexpected shard ${id} (the plan has ${planned.length})`);
 let combined='';
 planned.forEach((files,position)=>{
  const id=`${name}-${position+1}`,meta=shards.get(id);
  if(!meta){problems.push(`missing shard ${id}`);records.push({id,status:'missing'});return;}
  const fail=reason=>problems.push(`shard ${id}: ${reason}`),before0=problems.length;
  if(meta.count!==planned.length||meta.planMode!==plan.mode||meta.planSha256!==plan.sha256)fail(`ran plan ${meta.planMode} ${String(meta.planSha256).slice(0,12)} (${meta.count} shards), not ${plan.mode} ${plan.sha256.slice(0,12)} (${planned.length})`);
  if(!same(meta.files,files))fail('its file list differs from the plan');
  if(!Array.isArray(meta.files)||!meta.files.length)fail('it lists no test file');
  for(const problem of recordProblems(meta,{id,suite:name,files,scripts}))fail(problem);
  if(meta.environment?.node!==process.version||meta.environment?.platform!==process.platform||meta.environment?.arch!==process.arch)fail(`ran on Node ${meta.environment?.node} ${meta.environment?.platform}-${meta.environment?.arch}, not ${process.version} ${process.platform}-${process.arch}`);
  if(meta.platform?.host!==platform.host)fail(`ran on platform ${meta.platform?.host}, not ${platform.host}`);
  if(Object.hasOwn(platform,'reference')&&(meta.platform?.reference!==platform.reference||meta.platform?.policy!==platform.policy))fail(`ran with reference ${meta.platform?.reference} and policy ${meta.platform?.policy}, not ${platform.reference} and ${platform.policy}`);
  if(meta.revision!==before.revision)fail(`ran on revision ${meta.revision}, not ${before.revision}`);
  if(meta.sourceBefore!==before.sha256||meta.sourceAfter!==before.sha256||meta.revision!==before.revision)sourceStable=false;
  if(!same(meta.referenceBefore,referenceBefore)||!same(meta.referenceAfter,referenceBefore))referenceStable=false;
  const copy=(file,expectedSha,target=file)=>{
   if(typeof file!=='string'||!existsSync(resolve(directory,file)))return null;
   const bytes=readFileSync(resolve(directory,file));if(sha256(bytes)!==expectedSha){fail(`${file} does not match its recorded sha256`);return null;}
   const to=resolve(evidence,'shards',target);mkdirSync(dirname(to),{recursive:true});copyFileSync(resolve(directory,file),to);return bytes;
  };
  const log=/^[\w.-]+$/.test(String(meta.log))?copy(meta.log,meta.logSha256):null;if(log===null)fail('its log is missing');
  copyFileSync(resolve(directory,`${id}.shard.json`),resolve(evidence,'shards',`${id}.shard.json`));
  if(meta.preparation&&/^[\w.-]+$/.test(String(meta.preparation.log))&&copy(meta.preparation.log,meta.preparation.logSha256)===null)fail('its preparation log is missing');
  // Files the tests wrote under OUTPUT_ROOTS (compat/reports/inverse-instability.json): kept as evidence, restored by restoreOutputs.
  for(const output of Array.isArray(meta.outputs)?meta.outputs:[]){
   if(!outputPath(output?.path)||!DIGEST.test(String(output.sha256))){fail(`it records an invalid test output ${JSON.stringify(output?.path)}`);continue;}
   const stored=`${id}.outputs/${output.path}`,bytes=copy(stored,output.sha256);
   if(bytes===null){fail(`its test output ${output.path} is missing`);continue;}
   const earlier=outputs.get(output.path);
   if(earlier&&earlier.sha256!==output.sha256){fail(`its test output ${output.path} differs from the one shard ${earlier.shard} wrote`);continue;}
   if(!earlier)outputs.set(output.path,{shard:id,sha256:output.sha256,size:bytes.length,source:resolve(directory,stored)});
  }
  const bytes=meta.report?copy(meta.report,meta.reportSha256):null;
  combined+=`==> ${id}: ${(meta.command??[]).slice(0,2).join(' ')} <${files.length} files> exit ${meta.exitCode}${meta.signal?' '+meta.signal:''} in ${meta.durationMs} ms${meta.preparation?`; prepare ${meta.preparation.status}`:''}\n${log??''}\n`;
  const record={id,status:'present',files:files.length,command:meta.command,exitCode:meta.exitCode,signal:meta.signal,durationMs:meta.durationMs,startedAt:meta.startedAt,finishedAt:meta.finishedAt,
   log:relative(root,resolve(evidence,'shards',`${id}.log`)),logSha256:meta.logSha256,report:bytes?relative(root,resolve(evidence,'shards',meta.report)):null,reportSha256:meta.reportSha256,
   sourceBefore:meta.sourceBefore,sourceAfter:meta.sourceAfter,referenceBefore:meta.referenceBefore,referenceAfter:meta.referenceAfter,preparation:meta.preparation??null,outputs:Array.isArray(meta.outputs)?meta.outputs:null,ci:meta.ci??null};
  records.push(record);
  if(!bytes){fail('it wrote no Vitest JSON');return;}
  let raw;try{raw=rebase(JSON.parse(bytes.toString('utf8')),meta.root,root);}catch(error){fail(`unreadable Vitest JSON: ${error.message}`);return;}
  // Each shard must report exactly its planned files, with consistent counts, before it is merged.
  try{const summary=summarizeSuite(raw,files,root,policy);record.summary={status:summary.status,total:summary.total,passed:summary.passed,failed:summary.failed,notApplicable:summary.notApplicable,missingFiles:summary.missingFiles};if(summary.missingFiles.length)fail(`partial: ${summary.missingFiles.length} planned files have no results`);if(!summary.total)fail('empty: no test results');}
  catch(error){fail(String(error));}
  if(problems.length===before0)results.push(raw);
 });
 const logPath=resolve(evidence,`tests-${name}.log`);writeFileSync(logPath,combined);
 const present=records.filter(record=>record.status==='present'),allRan=!problems.some(problem=>problem.startsWith('missing'))&&present.length===planned.length&&planned.length>0;
 const prepared=record=>record.preparation===null||record.preparation.status==='passed'&&record.preparation.exitCode===0;
 const gate={name:`tests-${name}`,command:['node','tools/ci/shard.mjs','--suite',name,'--index',`1..${planned.length}`],
  status:allRan&&present.every(record=>record.exitCode===0&&!record.signal&&prepared(record))?'passed':'failed',exitCode:present.find(record=>record.exitCode!==0)?.exitCode??(allRan?0:null),signal:present.find(record=>record.signal)?.signal??null,
  durationMs:present.reduce((sum,record)=>sum+(record.durationMs??0),0),wallMs:Math.max(0,...present.map(record=>record.durationMs??0)),log:relative(root,logPath),logSha256:sha256(combined),shards:records};
 if(problems.length)return {gate,sourceStable,referenceStable,suite:{status:'invalid-evidence',reason:problems.join('; '),files:[],assertions:[],shards:records}};
 const merged={success:results.every(raw=>raw.success===true),numTotalTests:results.reduce((sum,raw)=>sum+raw.numTotalTests,0),numPassedTests:results.reduce((sum,raw)=>sum+raw.numPassedTests,0),
  numFailedTests:results.reduce((sum,raw)=>sum+raw.numFailedTests,0),testResults:results.flatMap(raw=>raw.testResults)};
 const file=resolve(evidence,`${name}.json`),serialized=JSON.stringify(merged);writeFileSync(file,serialized);
 try{
  const summary=summarizeSuite(merged,expected,root,policy);
  return {gate,sourceStable,referenceStable,suite:{...summary,status:gate.status==='passed'?summary.status:'failed',report:relative(root,file),reportSha256:sha256(serialized),shards:records}};
 }catch(error){return {gate,sourceStable,referenceStable,suite:{status:'invalid-evidence',reason:String(error),files:[],assertions:[],shards:records}};}
}
/**
 * Writes the collected test outputs into the checkout, where a serial run's tests would have left them, so the
 * aggregate's evidence upload carries them. Returns [{path, shard, sha256, size}].
 */
export function restoreOutputs(outputs,{root}){
 const restored=[];
 for(const [path,output]of [...outputs].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  if(!outputPath(path))throw new Error(`Refusing to restore ${path}`);
  const target=resolve(root,path),bytes=readFileSync(output.source);
  if(sha256(bytes)!==output.sha256)throw new Error(`${output.source} changed after it was verified`);
  if(!existsSync(target)||sha256(readFileSync(target))!==output.sha256){mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);}
  restored.push({path,shard:output.shard,sha256:output.sha256,size:output.size});
 }
 return restored;
}
