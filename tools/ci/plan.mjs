// Shard plans for the sharded validation pipeline (docs/contributing/ci.md).
//   node tools/ci/plan.mjs full                 plan every test file of the four suites
//   node tools/ci/plan.mjs fast [--base <ref>]  plan the affected tests of a wave2/** push (tools/ci/affected.mjs)
//   node tools/ci/plan.mjs auto                 full or fast from GITHUB_EVENT_NAME and GITHUB_REF
// Writes .build/ci/plan.json and, under GitHub Actions, the step outputs mode, plan, matrix and shards.
// A plan assigns every test file of a suite to exactly one shard. Files are balanced across a suite's shards by the
// measured durations in tools/ci/test-durations.json (longest first, each to the shard with the least time so far).
// A plan never changes what a shard runs: each shard runs its files with the options of the suite's npm script.
import {mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {snapshotSource} from '../compatibility-report/source.mjs';

import {SUITES,suiteFiles} from './suites.mjs';

export {SUITES,suiteFiles};
const root=resolve(import.meta.dirname,'../..');
const sha256=value=>createHash('sha256').update(value).digest('hex');
export function readConfig(directory=root){
 const config=JSON.parse(readFileSync(resolve(directory,'tools/ci/shards.json'),'utf8'));
 if(config.schemaVersion!==1||typeof config.profile!=='string'||SUITES.some(suite=>!Number.isInteger(config.shards?.[suite])||config.shards[suite]<1||config.shards[suite]>32))throw new Error('tools/ci/shards.json: expected schemaVersion 1, a profile and 1-32 shards per suite');
 return config;
}
export function readDurations(directory=root){return JSON.parse(readFileSync(resolve(directory,'tools/ci/test-durations.json'),'utf8'));}
const round=seconds=>Math.round(seconds*10)/10;

/**
 * Balanced shards of the given files. counts: shards per suite (capped at the suite's file count; a suite with no
 * file has no shard, which the aggregate reports as missing evidence). Returns {suites: {suite: [[file, ...], ...]}}.
 */
export function planShards(files,{counts,durations,profile,mode='full',selection=null}){
 const measured=durations?.profiles?.[profile]?.files??{},suites={},estimates={},unmeasured=[];
 for(const suite of SUITES){
  const list=suiteFiles(files,suite),known=list.filter(file=>Object.hasOwn(measured,file)).map(file=>measured[file]);
  const fallback=known.length?known.reduce((sum,value)=>sum+value,0)/known.length:1,weight=file=>Object.hasOwn(measured,file)&&Number.isFinite(measured[file])&&measured[file]>=0?measured[file]:fallback;
  for(const file of list)if(!Object.hasOwn(measured,file))unmeasured.push(file);
  const count=Math.min(counts[suite]??0,list.length),bins=Array.from({length:count},()=>({files:[],seconds:0}));
  for(const file of [...list].sort((a,b)=>weight(b)-weight(a)||(a<b?-1:a>b?1:0))){
   // Least time so far, then fewest files: an empty shard (0 s, 0 files) is always chosen first, so none stays empty.
   let best=bins[0];for(const bin of bins)if(bin.seconds<best.seconds||bin.seconds===best.seconds&&bin.files.length<best.files.length)best=bin;
   best.files.push(file);best.seconds+=weight(file);
  }
  suites[suite]=bins.map(bin=>bin.files.sort());estimates[suite]=bins.map(bin=>round(bin.seconds));
 }
 const identity={mode,suites};
 return {schemaVersion:1,kind:'edgeffmpeg-shard-plan',mode,sha256:sha256(JSON.stringify(identity)),profile,durationsSha256:sha256(JSON.stringify(durations?.profiles?.[profile]??null)),
  counts:Object.fromEntries(SUITES.map(suite=>[suite,suites[suite].length])),files:Object.fromEntries(SUITES.map(suite=>[suite,suites[suite].flat().length])),
  estimatedSeconds:estimates,unmeasured,selection,suites};
}
/** The full plan of a source snapshot file list: the plan compat:report --from-shards requires. */
export function fullPlan(files,directory=root){
 const config=readConfig(directory);
 return planShards(files,{counts:config.shards,durations:readDurations(directory),profile:config.profile});
}
/** Structural checks shared by every consumer of a plan: shard lists are non-empty, sorted and pairwise disjoint. */
export function validatePlan(plan){
 if(plan?.schemaVersion!==1||plan.kind!=='edgeffmpeg-shard-plan'||!['full','fast'].includes(plan.mode)||typeof plan.sha256!=='string')throw new Error('Invalid shard plan');
 if(sha256(JSON.stringify({mode:plan.mode,suites:plan.suites}))!==plan.sha256)throw new Error('Shard plan hash does not match its shards');
 const seen=new Set();
 for(const suite of SUITES){
  if(!Array.isArray(plan.suites?.[suite]))throw new Error(`Shard plan has no ${suite} list`);
  for(const files of plan.suites[suite]){
   if(!Array.isArray(files)||!files.length)throw new Error(`Shard plan has an empty ${suite} shard`);
   for(const file of files){if(typeof file!=='string'||suiteFiles([file],suite).length!==1||seen.has(file))throw new Error(`Shard plan lists ${file} outside ${suite} or in two shards`);seen.add(file);}
   if(files.some((file,index)=>index&&files[index-1]>=file))throw new Error(`Shard plan ${suite} files are not sorted`);
  }
 }
 return plan;
}
/** One matrix entry per shard, longest estimate first so the slowest shards start first. */
export function shardMatrix(plan){
 const entries=SUITES.flatMap(suite=>plan.suites[suite].map((_,position)=>({id:`${suite}-${position+1}`,suite,index:position+1,count:plan.suites[suite].length,estimate:plan.estimatedSeconds?.[suite]?.[position]??0})));
 return entries.sort((a,b)=>b.estimate-a.estimate||(a.id<b.id?-1:1)).map(({estimate,...entry})=>entry);
}
/** Whether a push runs the fast lane: wave2/** branches except integration branches (a path segment starting with "integration"). */
export function laneFor(env=process.env){
 if(env.GITHUB_EVENT_NAME!=='push'||!String(env.GITHUB_REF??'').startsWith('refs/heads/wave2/'))return 'full';
 const segments=env.GITHUB_REF.slice('refs/heads/'.length).split('/');
 return segments.some(segment=>segment.startsWith('integration'))?'full':'fast';
}

if(import.meta.url===`file://${process.argv[1]}`){
 const [requested,...rest]=process.argv.slice(2),option=name=>{const at=rest.indexOf(name);return at<0?null:rest[at+1]??null;};
 if(!['full','fast','auto'].includes(requested)){console.error('Usage: node tools/ci/plan.mjs full|fast|auto [--base <ref>] [--out <file>]');process.exit(2);}
 const mode=requested==='auto'?laneFor():requested,files=snapshotSource(root).files.map(entry=>entry.file);
 let plan;
 if(mode==='full')plan=fullPlan(files);
 else{
  const {affectedTests}=await import('./affected.mjs'),config=readConfig(),durations=readDurations();
  const selection=await affectedTests({root,base:option('--base')??config.fastLane.bases,files,config});
  const measured=durations.profiles[config.profile]?.files??{},chosen=new Set(selection.tests),counts={};
  for(const suite of SUITES){
   const list=suiteFiles(files,suite).filter(file=>chosen.has(file)),all=suiteFiles(files,suite),known=all.filter(file=>Object.hasOwn(measured,file));
   const mean=known.length?known.reduce((sum,file)=>sum+measured[file],0)/known.length:1,seconds=list.reduce((sum,file)=>sum+(measured[file]??mean),0);
   counts[suite]=Math.min(config.shards[suite],Math.max(1,Math.ceil(seconds/config.fastLane.shardSeconds)));
  }
  plan=planShards(files.filter(file=>chosen.has(file)),{counts,durations,profile:config.profile,mode:'fast',selection:{base:selection.base,mergeBase:selection.mergeBase,all:selection.all,changed:selection.changed,reasons:Object.fromEntries(Object.entries(selection.reasons).map(([test,list])=>[test,list[0]]))}});
 }
 validatePlan(plan);
 const out=resolve(root,option('--out')??'.build/ci/plan.json');mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify(plan,null,1)+'\n');
 const matrix=shardMatrix(plan);
 console.log(`${plan.mode} plan ${plan.sha256.slice(0,12)}: ${matrix.length} shards; files ${JSON.stringify(plan.files)}; estimated seconds ${JSON.stringify(plan.estimatedSeconds)}`);
 if(plan.unmeasured.length)console.log(`Unmeasured files (balanced at their suite's mean): ${plan.unmeasured.join(', ')}`);
 if(plan.selection)console.log(`Fast-lane selection against ${JSON.stringify(plan.selection.base)} (merge base ${plan.selection.mergeBase??'none'}), ${plan.selection.changed?.length??'unknown'} changed files: ${plan.selection.all?'every test file':`${Object.values(plan.files).reduce((a,b)=>a+b,0)} test files`}`);
 // The plan output reaches every shard as an environment variable, so it carries only what a shard and the fast-lane
 // check need; the per-test selection reasons stay in plan.json, which the plan job uploads.
 const compact={...plan,unmeasured:plan.unmeasured.length,selection:plan.selection&&{base:plan.selection.base,mergeBase:plan.selection.mergeBase,all:plan.selection.all,changed:plan.selection.changed?.length??null}};
 if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`mode=${plan.mode}\nshards=${matrix.length}\nmatrix=${JSON.stringify(matrix)}\nplan=${JSON.stringify(compact)}\n`);
}
