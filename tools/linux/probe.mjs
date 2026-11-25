// Selected-test runner shared by .github/workflows/linux-probe.yml and tools/linux/container-run.mjs.
//   node tools/linux/probe.mjs plan                      validate .github/linux-probe.json, print GitHub step outputs
//   node tools/linux/probe.mjs test --shard i/n --out d  run shard i of n of the configured tests
//   node tools/linux/probe.mjs run --out d <file...>     run the given test files
// Files are grouped by suite and run with the same Vitest options as that suite's npm script, with a JSON report per
// suite in the output directory. See docs/contributing/linux-reference.md.
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {executionEnvironment} from '../differential-runner/platform-corpus.mjs';

const root=resolve(import.meta.dirname,'../..'),configFile='.github/linux-probe.json';
export const SUITES=Object.freeze({unit:'test',integration:'test:integration',differential:'test:differential',workers:'test:workers'});
const testFile=/^tests\/(unit|integration|differential|workers)\/[\w./-]+\.(test|spec)\.[cm]?[jt]sx?$/;

/** Vitest options of a suite's npm script, e.g. ['--maxWorkers=1','--testTimeout=30000'] for differential. */
export function suiteOptions(suite,scripts=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).scripts){
 const words=String(scripts[SUITES[suite]]??'').trim().split(/\s+/);
 if(words[0]!=='vitest'||words[1]!=='run'||words[2]!==`tests/${suite}`||words.slice(3).some(word=>!/^--[\w-]+=[\w.]+$/.test(word)))throw new Error(`package.json script ${SUITES[suite]} is not \`vitest run tests/${suite} [--option=value ...]\``);
 return words.slice(3);
}
export function suiteOf(file){
 const match=testFile.exec(file);if(!match||file.split('/').includes('..'))throw new Error(`Not a test file under tests/<suite>/: ${file}`);
 return match[1];
}
/** Validated probe configuration {tests, shards, corpora}; corpora is 'all' or a list of descriptor ids. */
export function readProbeConfig(path=resolve(root,configFile)){
 if(!existsSync(path))throw new Error(`Missing ${configFile}; a linux-probe/** branch must commit one: {"tests":[...],"shards":n,"corpora":[...]|"all"}`);
 const config=JSON.parse(readFileSync(path,'utf8')),tests=config.tests??[],corpora=config.corpora??[],shards=config.shards??1;
 if(Object.keys(config).some(key=>!['tests','shards','corpora','comment'].includes(key)))throw new Error(`${configFile} has unknown keys`);
 if(!Array.isArray(tests)||new Set(tests).size!==tests.length)throw new Error(`${configFile} tests must be a list of distinct files`);
 for(const file of tests){suiteOf(file);if(!existsSync(resolve(root,file)))throw new Error(`${configFile} names a missing test file ${file}`);}
 if(!Number.isInteger(shards)||shards<1||shards>16||shards>Math.max(tests.length,1))throw new Error(`${configFile} shards must be an integer from 1 to min(16, number of tests)`);
 if(corpora!=='all'&&(!Array.isArray(corpora)||corpora.some(id=>typeof id!=='string'||!/^[a-z0-9-]+$/.test(id))))throw new Error(`${configFile} corpora must be "all" or a list of descriptor ids`);
 if(!tests.length&&(corpora!=='all'&&!corpora.length))throw new Error(`${configFile} selects neither tests nor corpora`);
 return {tests,shards:tests.length?shards:0,corpora};
}
/** Round-robin shard (1-based) of a file list. */
export function shardFiles(files,index,count){
 if(!Number.isInteger(index)||!Number.isInteger(count)||index<1||index>count)throw new Error(`Invalid shard ${index}/${count}`);
 return files.filter((_,position)=>position%count===index-1);
}
/** Runs files grouped by suite; returns {suite: {status, report}} and exits non-zero through the caller on failure. */
export function runTests(files,out,{label='run'}={}){
 if(!files.length)throw new Error('No test files selected');
 const groups={};for(const file of files)(groups[suiteOf(file)]??=[]).push(file);
 mkdirSync(out,{recursive:true});const results={};
 for(const [suite,selected]of Object.entries(groups)){
  const report=resolve(out,`${suite}-${label}.json`),args=['vitest','run',...selected,...suiteOptions(suite),'--reporter=default','--reporter=json',`--outputFile=${report}`];
  console.log(`[linux-probe] ${suite}: npx ${args.join(' ')}`);
  const started=Date.now(),result=spawnSync('npx',args,{cwd:root,stdio:'inherit'});
  let counts=null;try{const raw=JSON.parse(readFileSync(report,'utf8'));counts={total:raw.numTotalTests,passed:raw.numPassedTests,failed:raw.numFailedTests,pending:raw.numPendingTests,failedFiles:raw.testResults.filter(entry=>entry.status!=='passed').map(entry=>entry.name.replace(root+'/',''))};}catch{counts=null;}
  results[suite]={files:selected,status:result.status===0?'passed':'failed',exitCode:result.status,signal:result.signal,seconds:(Date.now()-started)/1000,report,counts};
 }
 writeFileSync(resolve(out,`summary-${label}.json`),JSON.stringify({label,environment:executionEnvironment(),ci:process.env.GITHUB_RUN_ID?{runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null,sha:process.env.GITHUB_SHA??null}:null,results},null,2)+'\n');
 return results;
}

if(import.meta.url===`file://${process.argv[1]}`){
 const [command,...rest]=process.argv.slice(2),option=name=>{const at=rest.indexOf(name);if(at<0)return null;const value=rest[at+1];if(!value||value.startsWith('--'))throw new Error(`${name} needs a value`);rest.splice(at,2);return value;};
 if(command==='plan'){
  const config=readProbeConfig(),lines=[`shards=${config.shards}`,`shard-list=${JSON.stringify(Array.from({length:config.shards},(_,index)=>index+1))}`,`tests=${config.tests.length}`,`corpora=${config.corpora==='all'?'all':config.corpora.join(',')}`];
  console.log(lines.join('\n'));if(process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,lines.join('\n')+'\n',{flag:'a'});
 }else if(command==='test'||command==='run'){
  const out=resolve(option('--out')??'.build/linux-probe'),shard=option('--shard');let files,label;
  if(command==='test'){const config=readProbeConfig(),[index,count]=(shard??'1/1').split('/').map(Number);if(count!==config.shards)throw new Error(`--shard ${shard} does not match ${config.shards} configured shards`);files=shardFiles(config.tests,index,count);label=`shard-${index}-of-${count}`;}
  else{if(shard)throw new Error('run takes explicit files, not --shard');files=rest;label='run';}
  const results=runTests(files,out,{label});console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([suite,result])=>[suite,{status:result.status,...result.counts}]))));
  if(Object.values(results).some(result=>result.status!=='passed'))process.exitCode=1;
 }else{console.error('Usage: node tools/linux/probe.mjs plan | test --shard i/n [--out dir] | run [--out dir] <test files...>');process.exitCode=2;}
}
