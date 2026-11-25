// Shard evidence for compat:report --from-shards (docs/contributing/ci.md). A suite's evidence is accepted only when
// every shard of the plan is present exactly once, each shard ran exactly its planned files on the same source,
// reference, platform and Node as the aggregate, and its Vitest JSON is intact. Missing, empty, partial, duplicated,
// unexpected or altered shards make the suite invalid evidence, so validation fails; they are never skipped.
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {sha256} from './source.mjs';
import {summarizeSuite} from './summarize.mjs';

export const SHARD_KIND='edgeffmpeg-test-shard';
const SHARD_RECORD=/^(unit|integration|differential|workers)-([1-9]\d*)\.shard\.json$/;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

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
/** Vitest JSON names files by absolute path; a shard that ran in another checkout path is rebased onto this root. */
function rebase(raw,shardRoot,root){
 if(!Array.isArray(raw?.testResults)||typeof shardRoot!=='string'||shardRoot===root)return raw;
 return {...raw,testResults:raw.testResults.map(entry=>typeof entry?.name==='string'&&entry.name.startsWith(shardRoot+'/')?{...entry,name:root+entry.name.slice(shardRoot.length)}:entry)};
}
/**
 * Evidence of one suite from its shards. context: {root, directory, evidence, plan, expected, policy, before,
 * referenceBefore, platform}. Returns {gate, suite, sourceStable, referenceStable}: the tests-<suite> gate (passed only
 * when every planned shard exited 0) and the suite summary of the merged Vitest results, or invalid-evidence.
 */
export function collectSuite(name,shards,context){
 const {root,directory,evidence,plan,expected,policy,before,referenceBefore,platform}=context;
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
  if(meta.environment?.node!==process.version||meta.environment?.platform!==process.platform||meta.environment?.arch!==process.arch)fail(`ran on Node ${meta.environment?.node} ${meta.environment?.platform}-${meta.environment?.arch}, not ${process.version} ${process.platform}-${process.arch}`);
  if(meta.platform?.host!==platform.host)fail(`ran on platform ${meta.platform?.host}, not ${platform.host}`);
  if(meta.sourceBefore!==before.sha256||meta.sourceAfter!==before.sha256||meta.revision!==before.revision)sourceStable=false;
  if(!same(meta.referenceBefore,referenceBefore)||!same(meta.referenceAfter,referenceBefore))referenceStable=false;
  const copy=(file,expectedSha)=>{
   if(typeof file!=='string'||!/^[\w.-]+$/.test(file)||!existsSync(resolve(directory,file)))return null;
   const bytes=readFileSync(resolve(directory,file));if(sha256(bytes)!==expectedSha){fail(`${file} does not match its recorded sha256`);return null;}
   copyFileSync(resolve(directory,file),resolve(evidence,'shards',file));return bytes;
  };
  const log=copy(meta.log,meta.logSha256);if(log===null)fail('its log is missing');
  copyFileSync(resolve(directory,`${id}.shard.json`),resolve(evidence,'shards',`${id}.shard.json`));
  const bytes=meta.report?copy(meta.report,meta.reportSha256):null;
  combined+=`==> ${id}: ${(meta.command??[]).slice(0,2).join(' ')} <${files.length} files> exit ${meta.exitCode}${meta.signal?' '+meta.signal:''} in ${meta.durationMs} ms\n${log??''}\n`;
  const record={id,status:'present',files:files.length,command:meta.command,exitCode:meta.exitCode,signal:meta.signal,durationMs:meta.durationMs,startedAt:meta.startedAt,finishedAt:meta.finishedAt,
   log:relative(root,resolve(evidence,'shards',`${id}.log`)),logSha256:meta.logSha256,report:bytes?relative(root,resolve(evidence,'shards',meta.report)):null,reportSha256:meta.reportSha256,
   sourceBefore:meta.sourceBefore,sourceAfter:meta.sourceAfter,referenceBefore:meta.referenceBefore,referenceAfter:meta.referenceAfter,preparation:meta.preparation??null,ci:meta.ci??null};
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
 const gate={name:`tests-${name}`,command:['node','tools/ci/shard.mjs','--suite',name,'--index',`1..${planned.length}`],
  status:allRan&&present.every(record=>record.exitCode===0&&!record.signal)?'passed':'failed',exitCode:present.find(record=>record.exitCode!==0)?.exitCode??(allRan?0:null),signal:present.find(record=>record.signal)?.signal??null,
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
