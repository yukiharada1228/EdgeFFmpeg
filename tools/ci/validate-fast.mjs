// npm run validate:fast [-- --concurrency <n>] [--out <dir>]
// Local full validation: the shards of the full plan (the same ones CI runs, tools/ci/plan.mjs) as parallel processes,
// then compat:report --from-shards, which runs every other gate once and validates the shards (docs/contributing/ci.md).
// reference:extract runs once before the shards, so they all see the tracked tree a serial compat:report run would test.
// Each shard is one Vitest process with its suite's npm-script options; differential shards keep --maxWorkers=1.
// The default concurrency is min(8, 60% of the logical CPUs, one shard per 2.5 GiB of memory): 6 on a 10-core 16 GB Mac.
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync,existsSync} from 'node:fs';
import {availableParallelism,totalmem} from 'node:os';
import {resolve,relative} from 'node:path';
import {snapshotSource} from '../compatibility-report/source.mjs';
import {fullPlan,shardMatrix} from './plan.mjs';

const root=resolve(import.meta.dirname,'../..'),args=process.argv.slice(2),option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]??null;};
export const defaultConcurrency=(cpus=availableParallelism(),memory=totalmem())=>Math.max(1,Math.min(8,Math.floor(cpus*0.6),Math.floor(memory/(2.5*1024**3))));
const concurrency=option('--concurrency')?Number(option('--concurrency')):defaultConcurrency();
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16){console.error('--concurrency must be an integer from 1 to 16');process.exit(2);}
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),out=resolve(process.env.INIT_CWD??process.cwd(),option('--out')??resolve(root,'.build/shards',stamp));
if(existsSync(resolve(out,'validate-fast.json')))throw new Error(`${relative(root,out)} already holds a validate:fast run; use a fresh --out`);
mkdirSync(out,{recursive:true});
const seconds=ms=>(ms/1000).toFixed(1)+' s',started=Date.now();
console.log(`[validate:fast] shards in ${relative(root,out)}, concurrency ${concurrency}`);
const prepare=spawnSync('npm',['run','reference:extract'],{cwd:root,encoding:'utf8'});
writeFileSync(resolve(out,'prepare.log'),`${prepare.stdout??''}${prepare.stderr??''}`);
console.log(`[validate:fast] reference:extract: ${prepare.status===0?'passed':'failed'} (the report's own reference-extract gate decides validation)`);
const plan=fullPlan(snapshotSource(root).files.map(entry=>entry.file)),matrix=shardMatrix(plan),runs=[],children=new Set();
console.log(`[validate:fast] plan ${plan.sha256.slice(0,12)}: ${matrix.length} shards ${JSON.stringify(plan.counts)}`);
const stop=signal=>{for(const child of children)child.kill(signal);process.exit(130);};
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop('SIGTERM'));
function runOne(entry){
 return new Promise(done=>{
  const fd=openSync(resolve(out,`${entry.id}.runner.log`),'w'),begin=Date.now();
  const child=spawn(process.execPath,['tools/ci/shard.mjs','--suite',entry.suite,'--index',String(entry.index),'--out',out],{cwd:root,stdio:['ignore',fd,fd]});
  children.add(child);console.log(`[validate:fast] start ${entry.id} (${plan.suites[entry.suite][entry.index-1].length} files)`);
  child.on('close',(code,signal)=>{children.delete(child);closeSync(fd);const run={id:entry.id,startMs:begin-started,durationMs:Date.now()-begin,exitCode:code,signal};runs.push(run);
   console.log(`[validate:fast] ${code===0?'passed':'FAILED'} ${entry.id} in ${seconds(run.durationMs)}${code===0?'':` (exit ${code}${signal?' '+signal:''}; see ${relative(root,resolve(out,entry.id+'.log'))})`}`);done();});
 });
}
const queue=[...matrix];
await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},async()=>{while(queue.length)await runOne(queue.shift());}));
const shardsMs=Date.now()-started;
console.log(`[validate:fast] shards finished in ${seconds(shardsMs)}; ${runs.filter(run=>run.exitCode!==0).length} failed. Running compat:report --from-shards`);
const reportStart=Date.now(),report=spawnSync('npm',['run','compat:report','--','--from-shards',out],{cwd:root,stdio:'inherit'}),reportMs=Date.now()-reportStart,totalMs=Date.now()-started;
writeFileSync(resolve(out,'validate-fast.json'),JSON.stringify({concurrency,plan:{sha256:plan.sha256,counts:plan.counts},timings:{shardsMs,reportMs,totalMs},runs:runs.sort((a,b)=>a.startMs-b.startMs),reportExitCode:report.status},null,1)+'\n');
console.log(`[validate:fast] wall time: shards ${seconds(shardsMs)}, report ${seconds(reportMs)}, total ${seconds(totalMs)}; compat:report exit ${report.status}`);
process.exitCode=report.status===0?0:1;
