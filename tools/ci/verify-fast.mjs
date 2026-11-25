// Checks the shards of a fast-lane plan (docs/contributing/ci.md).
//   node tools/ci/verify-fast.mjs --shards <dir> [--plan <file>] [--out <dir>]
// The plan comes from --plan or EDGEFFMPEG_CI_PLAN. Every planned shard must be present, ran exactly its files on one
// source and reference snapshot of this revision and platform, and passed with no failed test and no unexpected skip
// (the same per-shard and merged checks as compat:report --from-shards). This is fast-lane feedback, not a
// compatibility report: the full pipeline on integration branches produces the evidence.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readShardDirectory,collectSuite} from '../compatibility-report/shards.mjs';
import {passing,platformPolicy} from '../compatibility-report/summarize.mjs';
import {SUITES,validatePlan} from './plan.mjs';

const root=resolve(import.meta.dirname,'../..'),args=process.argv.slice(2),option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]??null;};
const cwd=process.env.INIT_CWD??process.cwd(),directory=resolve(cwd,option('--shards')??'.build/shards'),out=resolve(cwd,option('--out')??'.build/ci/fast');
const plan=validatePlan(JSON.parse(option('--plan')?readFileSync(resolve(cwd,option('--plan')),'utf8'):process.env.EDGEFFMPEG_CI_PLAN??'null'));
mkdirSync(out,{recursive:true});
const shards=readShardDirectory(directory),records=[...shards.values()],problems=[],results={};
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),host=`${process.platform}-${process.arch}`;
const first=records[0];
if(records.length&&first.platform?.host!==host)problems.push(`shards ran on ${first.platform?.host}, not ${host}`);
const policy=first?platformPolicy(JSON.parse(readFileSync(resolve(root,'compat/test-contracts.json'),'utf8')),first.platform):undefined;
for(const suite of SUITES){
 if(!plan.suites[suite].length)continue;
 const collected=collectSuite(suite,shards,{root,directory,evidence:out,plan,expected:plan.suites[suite].flat(),policy,before:{sha256:first?.sourceBefore,revision},referenceBefore:first?.referenceBefore??null,platform:{host}});
 results[suite]={gate:collected.gate.status,status:collected.suite.status,total:collected.suite.total??0,passed:collected.suite.passed??0,failed:collected.suite.failed??0,notApplicable:collected.suite.notApplicable??0,unexpectedSkips:collected.suite.unexpectedSkips??0,reason:collected.suite.reason??null};
 if(collected.gate.status!=='passed'||!passing(collected.suite.status))problems.push(`${suite}: ${collected.suite.status}${collected.suite.reason?` (${collected.suite.reason})`:''}`);
 if(!collected.sourceStable||!collected.referenceStable)problems.push(`${suite}: the shards ran on different source or reference snapshots of ${revision.slice(0,12)}`);
}
const summary={plan:{mode:plan.mode,sha256:plan.sha256,counts:plan.counts,files:plan.files,selection:plan.selection},revision,platform:first?.platform??null,results,problems,passed:problems.length===0};
writeFileSync(resolve(out,'fast-lane.json'),JSON.stringify(summary,null,1)+'\n');
for(const [suite,result]of Object.entries(results))console.log(`${suite}: ${result.status} (${result.passed} passed, ${result.failed} failed, ${result.notApplicable} not applicable, ${result.unexpectedSkips} unexpected skips of ${result.total})`);
if(!Object.keys(results).length)console.log('No test file was selected.');
for(const problem of problems)console.log(`FAIL ${problem}`);
console.log(problems.length?'Fast lane failed':'Fast lane passed');
process.exitCode=problems.length?1:0;
