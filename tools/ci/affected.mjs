// Affected-test selection for the wave2/** fast lane (docs/contributing/ci.md).
//   node tools/ci/affected.mjs [--base <ref>] [--changed <file> ...]   print the selection and why each test is in it
// The changes are those since the branch point: the nearest merge base with a remote branch matching fastLane.bases.
// A test file is selected when:
//   - it changed itself;
//   - it is a registry test (its file name contains fastLane.registryTest);
//   - it reaches a changed file through the dependency graph: static imports (esbuild's metafile, JSON imports included)
//     and repository paths written literally in a source (a Workers fixture bundled at run time, a corpus directory, a
//     tool it spawns). Registries and package entry points (fastLane.hubs) re-export every capability, so the graph is
//     not followed through them, and a change to one is covered by the registry tests;
//   - every test file is selected when a changed file matches fastLane.allTestsWhenChanged, when there is no merge base
//     with the base branch, or when the graph cannot be built.
// The fast lane is feedback, not evidence: integration branches run the full sharded pipeline and compat:report.
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {basename,resolve} from 'node:path';
import {build} from 'esbuild';
import {SUITES,suiteFiles} from './suites.mjs';

const MODULE=/\.(?:[cm]?[jt]sx?)$/;
/** Minimal glob: ** spans directories, * stays within one path segment. */
export function globMatcher(patterns){
 const expressions=patterns.map(pattern=>new RegExp('^'+pattern.split(/(\*\*\/?|\*)/).map(part=>part==='**/'?'(?:.*/)?':part==='**'?'.*':part==='*'?'[^/]*':part.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('')+'$'));
 return file=>expressions.some(expression=>expression.test(file));
}
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const tryGit=(root,...args)=>{try{return git(root,...args);}catch{return null;}};
/**
 * The branch point: of the remote branches matching the base patterns (the branch itself excluded), the one whose
 * merge base with HEAD is the fewest commits behind HEAD; ties go to the earlier pattern. A plain ref may be given.
 */
export function branchPoint(root,bases){
 const current=process.env.GITHUB_REF_NAME??tryGit(root,'rev-parse','--abbrev-ref','HEAD'),patterns=Array.isArray(bases)?bases:[bases];
 const remotes=(tryGit(root,'for-each-ref','--format=%(refname:short)','refs/remotes/origin/')??'').split('\n').filter(name=>name.startsWith('origin/')&&name!=='origin/HEAD').map(name=>name.slice('origin/'.length));
 let best=null;
 patterns.forEach((pattern,order)=>{
  const names=pattern.includes('*')?remotes.filter(globMatcher([pattern])):[pattern];
  for(const name of names){
   if(name===current)continue;
   const ref=[`origin/${name}`,name].find(candidate=>tryGit(root,'rev-parse','--verify','--quiet',`${candidate}^{commit}`));
   const mergeBase=ref?tryGit(root,'merge-base','HEAD',ref):null,distance=mergeBase?Number(tryGit(root,'rev-list','--count',`${mergeBase}..HEAD`)):NaN;
   if(Number.isFinite(distance)&&(!best||distance<best.distance||distance===best.distance&&order<best.order))best={base:name,mergeBase,distance,order};
  }
 });
 return best;
}
/** Files changed on this branch since its branch point, plus uncommitted and untracked changes. */
export function changedFiles(root,bases){
 const point=branchPoint(root,bases);
 if(!point)return {base:null,mergeBase:null,changed:null};
 const lines=[git(root,'diff','--name-only','--no-renames',point.mergeBase,'HEAD'),git(root,'diff','--name-only','--no-renames','HEAD'),git(root,'ls-files','--others','--exclude-standard')];
 return {base:point.base,mergeBase:point.mergeBase,changed:[...new Set(lines.join('\n').split('\n').filter(Boolean))].sort()};
}
/** Repository paths a source names literally: files, and directories of at least three segments. */
function literalReferences(source,fileSet,directorySet){
 const found=new Set();
 for(const match of source.matchAll(/(?<![\w./-])((?:tests|packages|tools|compat|docs)\/[\w@.-]+(?:\/[\w@.-]+)*)/g)){
  const path=match[1].replace(/\/+$/,'').replace(/\.$/,'');
  if(fileSet.has(path)||directorySet.has(path))found.add(path);
 }
 return found;
}
/** Dependency graph: forward edges file -> dependencies (imports and literal references). */
export async function dependencyGraph(root,files){
 const fileSet=new Set(files),directorySet=new Set();
 for(const file of files){const parts=file.split('/');for(let length=3;length<parts.length;length++)directorySet.add(parts.slice(0,length).join('/'));}
 const tests=SUITES.flatMap(suite=>suiteFiles(files,suite)),edges=new Map(),add=(from,to)=>{if(from!==to){if(!edges.has(from))edges.set(from,new Set());edges.get(from).add(to);}};
 const sources=new Map(),read=file=>{if(!sources.has(file)){try{sources.set(file,readFileSync(resolve(root,file),'utf8'));}catch{sources.set(file,'');}}return sources.get(file);};
 // Entry points: every test, and every repository module a test or helper names literally (bundled or spawned at run time).
 const entries=new Set(tests),pending=[...tests];
 while(pending.length){const file=pending.pop();for(const target of literalReferences(read(file),fileSet,directorySet)){add(file,target);if(MODULE.test(target)&&existsSync(resolve(root,target))&&!entries.has(target)){entries.add(target);pending.push(target);}}}
 const external={name:'external-packages',setup(builder){builder.onResolve({filter:/^[^./]/},args=>args.path.startsWith('@edge-ffmpeg/')?undefined:{path:args.path,external:true});}};
 const result=await build({absWorkingDir:root,entryPoints:[...entries].sort(),bundle:true,write:false,metafile:true,outdir:resolve(root,'.build/ci/graph'),platform:'node',format:'esm',logLevel:'silent',plugins:[external],
  loader:{'.wasm':'empty','.c':'empty','.h':'empty','.txt':'empty','.bin':'empty'}});
 for(const [file,input]of Object.entries(result.metafile.inputs)){
  if(file.startsWith('node_modules/')||!fileSet.has(file))continue;
  for(const imported of input.imports)if(!imported.external&&fileSet.has(imported.path))add(file,imported.path);
  if(MODULE.test(file))for(const target of literalReferences(read(file),fileSet,directorySet))add(file,target);
 }
 return {edges,tests};
}
/**
 * The affected tests of a change. changed: explicit changed files (otherwise from git against base). Returns
 * {base, mergeBase, changed, all, reasons: {test: [reason, ...]}, tests}.
 */
export async function affectedTests({root,base,files,config,changed:given=null}){
 const lane=config.fastLane,isHub=globMatcher(lane.hubs),isGlobal=globMatcher(lane.allTestsWhenChanged);
 const found=given?{base:null,mergeBase:null,changed:[...given].sort()}:changedFiles(root,base),{mergeBase,changed}=found;
 base=found.base??base;
 const tests=SUITES.flatMap(suite=>suiteFiles(files,suite)),reasons={},select=(test,reason)=>{(reasons[test]??=[]).push(reason);};
 const everything=reason=>{for(const test of tests)select(test,reason);return {base,mergeBase,changed,all:true,reasons,tests:[...tests].sort()};};
 if(!changed)return everything(`no merge base with ${JSON.stringify(base)}`);
 const global=changed.filter(file=>isGlobal(file));
 if(global.length)return everything(`changed ${global.join(', ')}`);
 const testSet=new Set(tests);
 for(const file of changed)if(testSet.has(file))select(file,'changed');
 for(const test of tests)if(basename(test).includes(lane.registryTest))select(test,'registry test');
 let graph;
 try{graph=await dependencyGraph(root,files);}catch(error){return everything(`the dependency graph failed: ${String(error.message??error).split('\n')[0]}`);}
 const importers=new Map();
 for(const [from,targets]of graph.edges)for(const to of targets){if(!importers.has(to))importers.set(to,new Set());importers.get(to).add(from);}
 for(const file of changed){
  if(isHub(file))continue;// covered by the registry tests
  // A changed file is reached through itself and through every literally referenced directory that contains it.
  const parts=file.split('/'),starts=[file,...parts.slice(0,-1).map((_,length)=>parts.slice(0,length+1).join('/')).filter(path=>path.split('/').length>=3)];
  const seen=new Set(starts),queue=[...starts];
  while(queue.length){
   const node=queue.shift();
   for(const importer of importers.get(node)??[]){
    if(seen.has(importer))continue;seen.add(importer);
    if(testSet.has(importer))select(importer,`depends on ${file}`);
    if(!isHub(importer))queue.push(importer);
   }
  }
 }
 return {base,mergeBase,changed,all:false,reasons,tests:Object.keys(reasons).sort()};
}

if(import.meta.url===`file://${process.argv[1]}`){
 const {readConfig}=await import('./plan.mjs'),{snapshotSource}=await import('../compatibility-report/source.mjs');
 const root=resolve(import.meta.dirname,'../..'),args=process.argv.slice(2),config=readConfig();
 const baseAt=args.indexOf('--base'),changedAt=args.indexOf('--changed');
 const selection=await affectedTests({root,base:baseAt>=0?args[baseAt+1]:config.fastLane.bases,files:snapshotSource(root).files.map(entry=>entry.file),config,changed:changedAt>=0?args.slice(changedAt+1):null});
 console.log(JSON.stringify({base:selection.base,mergeBase:selection.mergeBase,changed:selection.changed,all:selection.all,count:selection.tests.length},null,1));
 for(const test of selection.tests)console.log(`${test}: ${[...new Set(selection.reasons[test])].slice(0,3).join('; ')}`);
}
