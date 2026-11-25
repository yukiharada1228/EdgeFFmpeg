// Records per-file test durations from a compat:report evidence directory into tools/ci/test-durations.json.
//   node tools/ci/durations.mjs --evidence <.build/evidence/<run-id>> --profile <linux-x64|darwin-arm64> --source "<where it came from>"
// The planner (tools/ci/plan.mjs) balances shards with the linux-x64 profile; a file without a measurement gets its
// suite's mean. Durations only balance shards: they never select, skip or time out a test.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {SUITES} from './plan.mjs';

const root=resolve(import.meta.dirname,'../..'),target=resolve(root,'tools/ci/test-durations.json');
const args=process.argv.slice(2),option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]??null;};
const evidence=option('--evidence'),profile=option('--profile'),source=option('--source');
if(!evidence||!profile||!source||!/^[a-z0-9]+-[a-z0-9]+$/.test(profile)){console.error('Usage: node tools/ci/durations.mjs --evidence <dir> --profile <platform-arch> --source <description>');process.exit(2);}
const report=JSON.parse(readFileSync(resolve(evidence,'report.json'),'utf8'));
if(report.developmentValidation!=='passed'||report.platform?.host!==profile)throw new Error(`The evidence must be a passing ${profile} report`);
const files={};
for(const suite of SUITES){
 const raw=JSON.parse(readFileSync(resolve(evidence,`${suite}.json`),'utf8'));
 for(const entry of raw.testResults){
  const file=entry.name.replaceAll('\\','/').replace(/^.*?\/(tests\/(unit|integration|differential|workers)\/)/,'$1');
  if(!file.startsWith(`tests/${suite}/`)||!Number.isFinite(entry.endTime-entry.startTime))throw new Error(`Unexpected test result ${entry.name}`);
  files[file]=Math.round((entry.endTime-entry.startTime)/100)/10;
 }
}
const current=existsSync(target)?JSON.parse(readFileSync(target,'utf8')):{schemaVersion:1,comment:'',profiles:{}};
current.comment='Per-file Vitest durations in seconds (endTime - startTime of each file) from passing compat:report runs. tools/ci/plan.mjs balances CI shards with the linux-x64 profile. Durations only balance shards; they never select, skip or time out a test. Regenerate with tools/ci/durations.mjs.';
current.profiles[profile]={source,runId:report.runId,revision:report.sourceBefore?.revision??null,reportSha256:createHash('sha256').update(readFileSync(resolve(evidence,'report.json'))).digest('hex'),
 suiteSeconds:Object.fromEntries(SUITES.map(suite=>[suite,Math.round(report.gates.find(gate=>gate.name===`tests-${suite}`).durationMs/100)/10])),
 files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0))};
writeFileSync(target,JSON.stringify(current,null,1)+'\n');
console.log(`${relative(root,target)}: ${profile} ${Object.keys(files).length} files from ${source}`);
