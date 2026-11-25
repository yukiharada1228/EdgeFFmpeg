// Compares two compat:report results test by test (docs/contributing/ci.md).
//   node tools/ci/compare.mjs <baseline report.json> <candidate report.json> [--allow-added <test file> ...]
// Equivalent means: the same developmentValidation, platform, gate names and statuses, suite statuses and counts, test
// files, full test names with their Vitest status and outcome (as a multiset, so a repeated name must repeat as often)
// and contract statuses. Test files listed with --allow-added may exist only in the candidate; their tests are listed
// separately and must all pass. Exits 0 only when the reports are equivalent.
import {readFileSync} from 'node:fs';

const SUITES=['unit','integration','differential','workers'];
export function compareReports(baseline,candidate,{allowAdded=[]}={}){
 const differences=[],added=new Set(allowAdded),note=message=>differences.push(message);
 if(baseline.developmentValidation!==candidate.developmentValidation)note(`developmentValidation ${baseline.developmentValidation} -> ${candidate.developmentValidation}`);
 for(const key of ['host','reference','policy'])if(baseline.platform?.[key]!==candidate.platform?.[key])note(`platform.${key} ${baseline.platform?.[key]} -> ${candidate.platform?.[key]}`);
 const gates=report=>Object.fromEntries((report.gates??[]).map(gate=>[gate.name,gate.status]));
 if(JSON.stringify(gates(baseline))!==JSON.stringify(gates(candidate)))note(`gates ${JSON.stringify(gates(baseline))} -> ${JSON.stringify(gates(candidate))}`);
 for(const key of ['sourceStable','referenceStable'])if(baseline[key]!==candidate[key])note(`${key} ${baseline[key]} -> ${candidate[key]}`);
 const suites={},extra=[];
 for(const suite of SUITES){
  const a=baseline.suites?.[suite]??{},b=candidate.suites?.[suite]??{};
  const filesA=new Set((a.files??[]).map(file=>file.file)),filesB=new Set((b.files??[]).map(file=>file.file));
  const removed=[...filesA].filter(file=>!filesB.has(file)),new_=[...filesB].filter(file=>!filesA.has(file)),unexpected=new_.filter(file=>!added.has(file));
  if(removed.length)note(`${suite}: files only in the baseline: ${removed.join(', ')}`);
  if(unexpected.length)note(`${suite}: files only in the candidate: ${unexpected.join(', ')}`);
  const key=test=>JSON.stringify([test.file,test.name,test.status,test.outcome]),count=list=>{const map=new Map();for(const test of list)map.set(key(test),(map.get(key(test))??0)+1);return map;};
  const testsA=count(a.assertions??[]),testsB=count((b.assertions??[]).filter(test=>!new_.includes(test.file)));
  const only=(x,y)=>[...x].filter(([name,times])=>(y.get(name)??0)!==times).map(([name,times])=>`${name} x${times} (other: ${y.get(name)??0})`);
  for(const line of only(testsA,testsB).slice(0,20))note(`${suite}: baseline test ${line}`);
  for(const line of only(testsB,testsA).slice(0,20))note(`${suite}: candidate test ${line}`);
  const newTests=(b.assertions??[]).filter(test=>new_.includes(test.file));
  for(const test of newTests){extra.push(test);if(test.status!=='passed')note(`${suite}: added test ${test.file} > ${test.name} is ${test.status}`);}
  const counts=summary=>({status:summary.status,total:summary.total,passed:summary.passed,failed:summary.failed,notApplicable:summary.notApplicable,unexpectedSkips:summary.unexpectedSkips,files:(summary.files??[]).length});
  const adjusted={...counts(b),total:(b.total??0)-newTests.length,passed:(b.passed??0)-newTests.filter(test=>test.status==='passed').length,files:filesB.size-new_.length};
  if(JSON.stringify(counts(a))!==JSON.stringify(adjusted))note(`${suite}: ${JSON.stringify(counts(a))} -> ${JSON.stringify(adjusted)} (without added files)`);
  suites[suite]={baseline:counts(a),candidate:counts(b),addedFiles:new_,addedTests:newTests.length,tests:a.assertions?.length??0};
 }
 const contracts=report=>Object.fromEntries((report.contracts??[]).map(contract=>[contract.id,contract.status]));
 const ca=contracts(baseline),cb=contracts(candidate);
 for(const id of new Set([...Object.keys(ca),...Object.keys(cb)]))if(ca[id]!==cb[id])note(`contract ${id} ${ca[id]} -> ${cb[id]}`);
 return {equivalent:differences.length===0,differences,suites,contracts:{baseline:Object.keys(ca).length,candidate:Object.keys(cb).length},addedTests:extra.map(test=>`${test.file} > ${test.name}: ${test.status}`)};
}

if(import.meta.url===`file://${process.argv[1]}`){
 const args=process.argv.slice(2),at=args.indexOf('--allow-added'),allowAdded=at>=0?args.splice(at).slice(1):[];
 if(args.length!==2){console.error('Usage: node tools/ci/compare.mjs <baseline report.json> <candidate report.json> [--allow-added <test file> ...]');process.exit(2);}
 const [baseline,candidate]=args.map(path=>JSON.parse(readFileSync(path,'utf8')));
 const result=compareReports(baseline,candidate,{allowAdded});
 console.log(JSON.stringify(result,null,1));
 console.log(result.equivalent?'EQUIVALENT':'DIFFERENT');
 process.exitCode=result.equivalent?0:1;
}
