// Replays the fast-lane selection of other branches and checks it against an independent oracle (docs/contributing/ci.md).
//   node tools/ci/replay-fast.mjs --worktree <dir> --out <dir> <branch> ...
// <worktree> is a git worktree of this repository that the replay may check out (detached) at origin/<branch>. For each
// branch the replay:
//   - computes the selection exactly as the plan job of a push of <branch> would, but with this checkout's tools/ci
//     (affected.mjs, shards.json): the branch point among fastLane.bases, the changed files and the selected tests;
//   - computes, independently of affected.mjs and esbuild, the tests that must be selected:
//       - imports: every test whose transitive imports, resolved by the TypeScript compiler (bundler resolution, so
//         workspace packages through their exports, type-only, re-exports and literal dynamic imports included),
//         reach a changed file;
//       - paths: every test whose own source names a changed file, or a directory holding one, by a path relative to
//         the root or to the test's directory;
//       - the changed tests themselves;
//     against the branch's own base: the newest of origin/wave2/prep and origin/wave2/base that is a proper ancestor of
//     the branch, or --oracle-base <ref>;
//   - passes when the selection includes every required test and its merge base is that base.
// Writes <out>/<branch>.json per branch and <out>/summary.json; exits 1 when a branch fails.
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {posix,relative,resolve} from 'node:path';
import ts from 'typescript';
import {affectedTests} from './affected.mjs';
import {readConfig,readDurations,fastPlan} from './plan.mjs';
import {SUITES,suiteFiles} from './suites.mjs';

const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024}).trim();
const tryGit=(root,...args)=>{try{return git(root,...args);}catch{return null;}};
const MODULE=/\.(?:[cm]?[jt]sx?)$/;

/** Import edges of every module, resolved by the TypeScript compiler: file -> Set(file). */
export function importGraph(root,files){
 const fileSet=new Set(files),real=realpathSync(root),edges=new Map(),unresolved=[];
 const options={module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,target:ts.ScriptTarget.ESNext,allowJs:true,checkJs:false,resolveJsonModule:true,allowImportingTsExtensions:true,allowArbitraryExtensions:true,noEmit:true};
 const cache=ts.createModuleResolutionCache(real,name=>name,options);
 const repoPath=absolute=>{let path;try{path=relative(real,realpathSync(absolute)).split('\\').join('/');}catch{return null;}return path.startsWith('..')?null:path;};
 const add=(from,to)=>{if(from!==to){if(!edges.has(from))edges.set(from,new Set());edges.get(from).add(to);}};
 for(const file of files){
  if(!MODULE.test(file))continue;
  let text;try{text=readFileSync(resolve(real,file),'utf8');}catch{continue;}
  const info=ts.preProcessFile(text,true,true);
  for(const {fileName}of [...info.importedFiles,...info.referencedFiles.map(reference=>({fileName:reference.fileName.startsWith('.')?reference.fileName:`./${reference.fileName}`}))]){
   const result=ts.resolveModuleName(fileName,resolve(real,file),options,ts.sys,cache),target=result.resolvedModule?.resolvedFileName;
   if(!target){if(fileName.startsWith('.')||fileName.startsWith('@edge-ffmpeg/'))unresolved.push({from:file,specifier:fileName});continue;}
   const path=repoPath(target);if(!path||!fileSet.has(path))continue;
   add(file,path);
   // A declaration next to its module (x.d.ts beside x.js) stands for both: the test runs the module.
   const stem=path.replace(/\.d\.([cm]?)ts$/,'');
   if(stem!==path)for(const extension of ['.js','.mjs','.cjs'])if(fileSet.has(stem+extension))add(file,stem+extension);
  }
 }
 return {edges,unresolved};
}
/** Tests that must be selected for a change: by imports (transitively), by their own path literals, or changed. */
export function requiredTests(root,files,changed){
 const tests=SUITES.flatMap(suite=>suiteFiles(files,suite)),testSet=new Set(tests),fileSet=new Set(files);
 const {edges,unresolved}=importGraph(root,files),importers=new Map();
 for(const [from,targets]of edges)for(const to of targets){if(!importers.has(to))importers.set(to,new Set());importers.get(to).add(from);}
 const required=new Map(),need=(test,reason)=>{if(!required.has(test))required.set(test,reason);};
 for(const file of changed)if(testSet.has(file))need(file,'changed');
 for(const file of changed.filter(file=>fileSet.has(file))){
  const previous=new Map([[file,null]]),queue=[file];
  while(queue.length){const node=queue.shift();for(const importer of importers.get(node)??[]){if(previous.has(importer))continue;previous.set(importer,node);queue.push(importer);
   if(testSet.has(importer)){const chain=[];for(let item=importer;item!==null;item=previous.get(item))chain.push(item);need(importer,`imports ${chain.slice(1).join(' -> ')}`);}}}
 }
 // Path literals of the test itself: a quoted string naming a changed file or a directory above one.
 const targets=new Set();for(const file of changed){targets.add(file);let directory=posix.dirname(file);while(directory.includes('/')){targets.add(directory);directory=posix.dirname(directory);}}
 for(const test of tests){
  let text;try{text=readFileSync(resolve(root,test),'utf8');}catch{continue;}
  for(const match of text.matchAll(/(['"`])([^'"`\s$]*\/[^'"`\s$]*)\1/g)){
   const literal=match[2].replace(/[?#].*$/,'');if(!/[\w@]/.test(literal))continue;// '/' or '../' alone names no path
   const candidates=[posix.normalize(literal.replace(/^\/+/,'')),posix.normalize(posix.join(posix.dirname(test),literal))].map(path=>path.replace(/\/+$/,''));
   const hit=candidates.find(path=>targets.has(path));if(hit)need(test,`names ${hit}`);
  }
 }
 return {required,unresolved,tests};
}
function linkWorkspaces(root){
 const directory=resolve(root,'node_modules/@edge-ffmpeg');rmSync(directory,{recursive:true,force:true});mkdirSync(directory,{recursive:true});
 for(const name of readdirSync(resolve(root,'packages'))){
  const manifest=resolve(root,'packages',name,'package.json');if(!existsSync(manifest))continue;
  const packageName=JSON.parse(readFileSync(manifest,'utf8')).name;if(typeof packageName!=='string'||!packageName.startsWith('@edge-ffmpeg/'))continue;
  symlinkSync(`../../packages/${name}`,resolve(directory,packageName.slice('@edge-ffmpeg/'.length)));
 }
}
/** The branch's own base: the newest wave2 base that is a proper ancestor of HEAD. */
function oracleBase(root,given){
 if(given)return git(root,'rev-parse',`${given}^{commit}`);
 const head=git(root,'rev-parse','HEAD');
 for(const ref of ['origin/wave2/prep','origin/wave2/base']){const commit=tryGit(root,'rev-parse',`${ref}^{commit}`);if(commit&&commit!==head&&tryGit(root,'merge-base','--is-ancestor',commit,'HEAD')!==null)return commit;}
 return null;
}
export async function replay(branch,{worktree,config=readConfig(),durations=readDurations(),given=null}){
 if(git(worktree,'status','--porcelain','--untracked-files=no'))throw new Error(`${worktree} has uncommitted changes`);
 git(worktree,'checkout','-q','--detach',`origin/${branch}`);linkWorkspaces(worktree);
 const head=git(worktree,'rev-parse','HEAD'),files=git(worktree,'ls-files','--cached','--others','--exclude-standard').split('\n').filter(Boolean).sort();
 const started=Date.now(),selection=await affectedTests({root:worktree,base:config.fastLane.bases,files,config,current:branch}),selectionMs=Date.now()-started;
 const base=oracleBase(worktree,given),changed=base?git(worktree,'diff','--name-only','--no-renames',base,'HEAD').split('\n').filter(Boolean).sort():null;
 const oracleStarted=Date.now(),oracle=changed?requiredTests(worktree,files,changed):null,oracleMs=Date.now()-oracleStarted;
 const selected=new Set(selection.tests),missing=oracle?[...oracle.required].filter(([test])=>!selected.has(test)).map(([test,reason])=>({test,reason})):null;
 const plan=fastPlan(files,selection,{config,durations}),estimates=Object.fromEntries(SUITES.map(suite=>[suite,plan.estimatedSeconds?.[suite]??[]]));
 const problems=[];
 if(!base)problems.push('no wave2 base is a proper ancestor of the branch');
 if(base&&selection.mergeBase!==base)problems.push(`the selection's merge base ${selection.mergeBase} (${selection.base}) is not the branch's base ${base}`);
 if(changed&&JSON.stringify(changed)!==JSON.stringify(selection.changed))problems.push('the selection changed files differ from the diff against the base');
 if(missing?.length)problems.push(`${missing.length} required tests are not selected`);
 const byImports=oracle?[...oracle.required.values()].filter(reason=>reason.startsWith('imports')).length:0;
 return {branch,head,base:selection.base,mergeBase:selection.mergeBase,oracleBase:base,rejectedBases:selection.rejectedBases,changed:selection.changed,all:selection.all,
  testFiles:SUITES.flatMap(suite=>suiteFiles(files,suite)).length,selected:selection.tests.length,required:oracle?.required.size??null,requiredByImports:byImports,missing,
  counts:Object.fromEntries(SUITES.map(suite=>[suite,{files:plan.suites[suite].flat().length,shards:plan.suites[suite].length}])),
  estimatedSeconds:{longestShard:Math.max(0,...Object.values(estimates).flat()),total:Object.values(estimates).flat().reduce((sum,value)=>sum+value,0)},
  selectionMs,oracleMs,graphFailures:selection.graphFailures??[],unresolvedImports:oracle?.unresolved.length??null,
  problems,passed:problems.length===0,selectedTests:selection.tests,requiredTests:oracle?Object.fromEntries(oracle.required):null};
}

if(import.meta.url===`file://${process.argv[1]}`){
 const args=process.argv.slice(2),option=name=>{const at=args.indexOf(name);if(at<0)return null;const value=args[at+1];args.splice(at,2);return value;};
 const cwd=process.env.INIT_CWD??process.cwd(),worktree=resolve(cwd,option('--worktree')??''),out=resolve(cwd,option('--out')??'.build/ci/replay'),given=option('--oracle-base');
 if(!args.length||!existsSync(resolve(worktree,'.git'))){console.error('Usage: node tools/ci/replay-fast.mjs --worktree <git worktree> --out <dir> [--oracle-base <ref>] <branch> ...');process.exit(2);}
 mkdirSync(out,{recursive:true});const config=readConfig(),durations=readDurations(),results=[];
 console.log('branch\tbase\tchanged\tselected\trequired\tby-imports\tmissing\tlongest-shard-s\tselection-s\tresult');
 for(const branch of args){
  let result;try{result=await replay(branch,{worktree,config,durations,given});}catch(error){result={branch,passed:false,problems:[String(error.message??error)]};}
  writeFileSync(resolve(out,`${branch.replaceAll('/','__')}.json`),JSON.stringify(result,null,1)+'\n');
  const {selectedTests,requiredTests:_,...brief}=result;results.push(brief);
  console.log([branch,result.base,result.changed?.length,result.selected,result.required,result.requiredByImports,result.missing?.length,result.estimatedSeconds?.longestShard?.toFixed?.(0),((result.selectionMs??0)/1000).toFixed(1),result.passed?'PASS':`FAIL ${result.problems.join('; ')}`].join('\t'));
 }
 const tools=git(resolve(import.meta.dirname,'../..'),'rev-parse','HEAD');
 writeFileSync(resolve(out,'summary.json'),JSON.stringify({tools,config:config.fastLane,branches:results.length,passed:results.filter(result=>result.passed).length,results},null,1)+'\n');
 process.exitCode=results.every(result=>result.passed)?0:1;
}
