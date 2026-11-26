// Affected-test selection for the wave2/** fast lane (docs/contributing/ci.md).
//   node tools/ci/affected.mjs [--base <ref>] [--changed <file> ...] [--json <file>]
// Prints the selection and, for each test, the dependency chain that selected it.
// The changes are those since the branch point (branchPoint below), plus uncommitted and untracked files.
// A test file is selected when:
//   - it changed itself;
//   - it is a registry test (its file name contains fastLane.registryTest);
//   - it reaches a changed file through the dependency graph, followed through every module: package entry points,
//     barrels and registries included, so a test that sees registry state through an index is selected for every
//     operator the registry holds. The graph's edges are:
//       - imports: static and literal dynamic imports and re-exports (esbuild's metafile, JSON imports included). An
//         import of a file that is not in the checkout (a Wasm module a Workers test copies next to its fixture) is
//         left out; an entry that still does not bundle depends on every file;
//       - path literals: a repository file or directory a source names, as a root-relative path ('tests/fixtures/x'),
//         a path relative to the source's own directory ('../../compat/x.json', new URL('./a.wasm', import.meta.url)),
//         the static parts of a template literal (`${root}/compat/behavior-specs/${name}`: compat/behavior-specs) or
//         consecutive string arguments ('..', 'fixtures'). A name that is no file or directory falls back to the
//         directory that holds it, so a path built from a prefix reaches the whole directory;
//       - directories: a referenced directory depends on every tracked file under it, and every module under it is
//         an entry of the graph (a Workers fixture directory bundled at run time);
//       - workspace specifiers: '@edge-ffmpeg/<name>' anywhere in a source names that package's manifest and entry
//         points (its exports), so a type-only import that esbuild drops still reaches the package's index;
//       - npm scripts: a source that runs `npm run <script>` depends on every path that script names;
//       - repository scans: a source that lists the repository (git ls-files, snapshotSource) depends on every file.
//     Referenced modules and text files (JSON corpora, Python and shell tools) are scanned for path literals in turn.
//     Type declarations (.d.ts) are scanned as text, never bundled;
//   - a changed file was deleted: every source that names it, and every directory that held it, is a start;
//   - every test file is selected when a changed file matches fastLane.allTestsWhenChanged, when there is no branch
//     point, or when the graph cannot be built.
// The selection prefers selecting too much to missing a test. The fast lane is feedback, not evidence: integration
// branches run the full sharded pipeline and compat:report.
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {basename,posix,relative,resolve} from 'node:path';
import {build} from 'esbuild';
import {SUITES,suiteFiles} from './suites.mjs';

const MODULE=/\.(?:[cm]?[jt]sx?)$/,DECLARATION=/\.d\.[cm]?ts$/;
const isModule=file=>MODULE.test(file)&&!DECLARATION.test(file);
// Text files whose path literals are followed when a source references them.
const SCANNED=/\.(?:[cm]?[jt]sx?|json|jsonc|py|sh|txt|toml|ya?ml)$/;
const MAX_SCANNED_BYTES=4*1024*1024;
/** Minimal glob: ** spans directories, * stays within one path segment. */
export function globMatcher(patterns){
 const expressions=patterns.map(pattern=>new RegExp('^'+pattern.split(/(\*\*\/?|\*)/).map(part=>part==='**/'?'(?:.*/)?':part==='**'?'.*':part==='*'?'[^/]*':part.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('')+'$'));
 return file=>expressions.some(expression=>expression.test(file));
}
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024}).trim();
const tryGit=(root,...args)=>{try{return git(root,...args);}catch{return null;}};
/**
 * The branch point. Candidates are the remote branches matching the base patterns, except the branch itself, any
 * branch matching notBases (integration branches: they merge feature branches, so they are downstream of them) and
 * any branch that already contains HEAD (its merge base would be HEAD and hide the whole change). Of the rest, the
 * one whose merge base with HEAD is the fewest commits behind HEAD wins; ties go to the earlier pattern. A plain ref
 * may be given. current: the branch being tested (default GITHUB_REF_NAME, else the checked-out branch).
 */
export function branchPoint(root,bases,{notBases=[],current=process.env.GITHUB_REF_NAME??tryGit(root,'rev-parse','--abbrev-ref','HEAD')}={}){
 const patterns=Array.isArray(bases)?bases:[bases],downstream=globMatcher(notBases),head=tryGit(root,'rev-parse','HEAD');
 const remotes=(tryGit(root,'for-each-ref','--format=%(refname:short)','refs/remotes/origin/')??'').split('\n').filter(name=>name.startsWith('origin/')&&name!=='origin/HEAD').map(name=>name.slice('origin/'.length));
 let best=null;const rejected=[],considered=new Set();
 patterns.forEach((pattern,order)=>{
  const names=pattern.includes('*')?remotes.filter(globMatcher([pattern])):[pattern];
  for(const name of names){
   if(name===current||considered.has(name))continue;considered.add(name);
   if(downstream(name)){rejected.push({base:name,reason:'integration branch'});continue;}
   const ref=[`origin/${name}`,name].find(candidate=>tryGit(root,'rev-parse','--verify','--quiet',`${candidate}^{commit}`));
   const mergeBase=ref?tryGit(root,'merge-base','HEAD',ref):null;
   if(!mergeBase)continue;
   if(mergeBase===head){rejected.push({base:name,reason:'already contains HEAD'});continue;}
   const distance=Number(tryGit(root,'rev-list','--count',`${mergeBase}..HEAD`));
   if(Number.isFinite(distance)&&(!best||distance<best.distance||distance===best.distance&&order<best.order))best={base:name,mergeBase,distance,order};
  }
 });
 return best&&{...best,rejected};
}
/** Files changed on this branch since its branch point, plus uncommitted and untracked changes. */
export function changedFiles(root,bases,options={}){
 const point=branchPoint(root,bases,options);
 if(!point)return {base:null,mergeBase:null,changed:null};
 const lines=[git(root,'diff','--name-only','--no-renames',point.mergeBase,'HEAD'),git(root,'diff','--name-only','--no-renames','HEAD'),git(root,'ls-files','--others','--exclude-standard')];
 return {base:point.base,mergeBase:point.mergeBase,distance:point.distance,rejected:point.rejected,changed:[...new Set(lines.join('\n').split('\n').filter(Boolean))].sort()};
}
const normalize=path=>{const value=posix.normalize(path).replace(/\/+$/,'');return value==='.'||value===''||value.startsWith('../')||value==='..'?null:value;};
const ALTERNATES=[[/\.js$/,['.ts','.tsx','.mts']],[/\.mjs$/,['.mts']],[/\.cjs$/,['.cts']],[/\.jsx$/,['.tsx']]];
/**
 * Repository paths a source names: root-relative and source-relative path literals, the static parts of templates,
 * consecutive string arguments and single quoted names. Returns files and directories of the repository.
 */
export function pathReferences(source,file,{fileSet,directorySet}){
 const found=new Set(),here=posix.dirname(file);
 const exists=path=>path&&(fileSet.has(path)||directorySet.has(path));
 // A token is path-shaped when it is explicitly relative or starts with a top-level directory of the repository.
 const topLevel=token=>{const first=token.replace(/^\/+/,'').split('/')[0];return first!==''&&directorySet.has(first);};
 const accept=(candidate,{fallback})=>{
  const token=candidate.replace(/[?#].*$/,'');if(!token||token.length>512)return;
  const relative=token.startsWith('./')||token.startsWith('../');
  const options=relative?[posix.join(here,token),token]:[token.replace(/^\/+/,''),posix.join(here,token)];
  let matched=false;
  for(const option of options){
   const path=normalize(option);if(!path)continue;
   if(exists(path)){found.add(path);matched=true;continue;}
   for(const [pattern,replacements]of ALTERNATES)if(pattern.test(path))for(const replacement of replacements){const alternate=path.replace(pattern,replacement);if(fileSet.has(alternate)){found.add(alternate);matched=true;}}
  }
  if(matched||!fallback||!(relative||topLevel(token)))return;
  // A prefix or a file not in the tree (a name completed at run time, an output file): the directory that holds it.
  const path=normalize(relative?posix.join(here,token):token.replace(/^\/+/,''));if(!path)return;
  let directory=posix.dirname(path);
  while(directory&&directory!=='.'&&!directorySet.has(directory))directory=posix.dirname(directory);
  // Only a directory below the top level: a whole top-level directory would be a guess, not a reference.
  if(directory&&directory!=='.'&&directory.includes('/'))found.add(directory);
 };
 // Every run of path characters that contains a slash, wherever it is (strings, templates, comments).
 for(const match of source.matchAll(/[\w@.+\-/]*\/[\w@.+\-/]*/g)){
  const token=match[0].replace(/(?<=[^./])[.\-+]+$/,'');
  if(token.startsWith('//')||token==='/')continue;// a URL, a comment marker or a division
  accept(token,{fallback:true});
 }
 // Single quoted names: 'fixtures', "packages". A lone '..' is only a step of a joined path (below).
 for(const match of source.matchAll(/(['"`])([\w@.+-]{2,})\1/g))if(!/^\.+$/.test(match[2]))accept(match[2],{fallback:false});
 // Consecutive string arguments: join(root, 'compat', 'behavior-specs', name) names compat/behavior-specs, and
 // join(import.meta.dirname, '..', 'fixtures', 'a.json') names ../fixtures/a.json.
 for(const match of source.matchAll(/(['"`])[\w@.+\-/]+\1(?:\s*,\s*(['"`])[\w@.+\-/]+\2)+/g)){
  const parts=[...match[0].matchAll(/(['"`])([\w@.+\-/]+)\1/g)].map(part=>part[2]);
  accept(parts.join('/'),{fallback:true});
 }
 return found;
}
/** npm scripts a source runs: `npm run <name>`, `npm test`, spawn('npm', ['run', '<name>']). */
export function scriptReferences(source,scripts){
 const names=new Set();
 for(const match of source.matchAll(/\bnpm(?:\.cmd)?\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g))names.add(match[1]);
 for(const match of source.matchAll(/(['"`])run(?:-script)?\1\s*,\s*(['"`])([\w:.-]+)\2/g))names.add(match[3]);
 if(/(['"`])npm(?:\.cmd)?\1\s*,\s*\[\s*(['"`])test\2/.test(source)||/\bnpm(?:\.cmd)?\s+test\b/.test(source))names.add('test');
 return [...names].filter(name=>Object.hasOwn(scripts,name));
}
const REPOSITORY_SCAN=/\bls-files\b|\bsnapshotSource\s*\(/;
/** Every directory above a tracked file (top level included), with the files under it. */
function directoriesOf(files){
 const contents=new Map();
 for(const file of files){const parts=file.split('/');for(let length=1;length<parts.length;length++){const directory=parts.slice(0,length).join('/');if(!contents.has(directory))contents.set(directory,[]);contents.get(directory).push(file);}}
 return contents;
}
/** Whether a relative import names a file of the checkout, directly or through the resolutions esbuild tries. */
function importable(path){
 if(existsSync(path))return true;
 const candidates=[...['.ts','.tsx','.mts','.cts','.js','.mjs','.cjs','.jsx','.json'].map(extension=>path+extension),...['index.ts','index.js','index.mjs','index.tsx'].map(name=>`${path}/${name}`)];
 for(const [pattern,replacements]of ALTERNATES)if(pattern.test(path))for(const replacement of replacements)candidates.push(path.replace(pattern,replacement));
 return candidates.some(candidate=>existsSync(candidate));
}
/**
 * Dependency graph over repository files and directories: edges file -> what it depends on. '.' stands for the
 * whole repository. files: every tracked file (the graph's nodes); tests: the test files (entries).
 * Returns {edges, tests, failed: [{entry, error}], missing: [{from, path}], sources, bundles}.
 */
export async function dependencyGraph(root,files,{tests=SUITES.flatMap(suite=>suiteFiles(files,suite))}={}){
 const fileSet=new Set(files),contents=directoriesOf(files),directorySet=new Set(contents.keys()),edges=new Map(),context={fileSet,directorySet};
 const add=(from,to)=>{if(from!==to){if(!edges.has(from))edges.set(from,new Set());edges.get(from).add(to);}};
 const sources=new Map(),read=file=>{
  if(!sources.has(file)){let text='';try{const path=resolve(root,file);if(statSync(path).size<=MAX_SCANNED_BYTES)text=readFileSync(path,'utf8');}catch{text='';}sources.set(file,text);}
  return sources.get(file);
 };
 let scripts={};try{scripts=JSON.parse(read('package.json')||'{}').scripts??{};}catch{scripts={};}
 const scriptPaths=new Map(),pathsOfScript=(name,seen=new Set())=>{
  if(scriptPaths.has(name))return scriptPaths.get(name);if(seen.has(name))return new Set();seen.add(name);
  const command=String(scripts[name]??''),paths=new Set();
  for(const token of command.split(/[\s=]+/)){const path=normalize(token.replace(/^['"]|['"]$/g,''));if(path&&(fileSet.has(path)||directorySet.has(path)))paths.add(path);}
  for(const nested of scriptReferences(command,scripts))if(nested!==name)for(const path of pathsOfScript(nested,seen))paths.add(path);
  scriptPaths.set(name,paths);return paths;
 };
 const under=directory=>contents.get(directory)??[];
 // Workspace packages by name: a specifier '@edge-ffmpeg/<name>' names the package's manifest and every file its
 // exports or main lists, so an import esbuild drops (import type) or a name in a string still reaches the package.
 const workspaces=new Map();
 for(const file of files){
  if(!/^packages\/[^/]+\/package\.json$/.test(file))continue;
  let manifest;try{manifest=JSON.parse(read(file));}catch{continue;}
  if(typeof manifest?.name!=='string')continue;
  const directory=posix.dirname(file),entries=new Set([file]),collect=value=>{if(typeof value==='string'){const path=normalize(posix.join(directory,value));if(path&&fileSet.has(path))entries.add(path);}else if(value&&typeof value==='object')for(const nested of Object.values(value))collect(nested);};
  collect(manifest.exports);collect(manifest.main);collect(manifest.module);collect(manifest.types);
  workspaces.set(manifest.name,{directory,entries});
 }
 const workspaceReferences=text=>{
  const found=new Set();
  for(const match of text.matchAll(/(?<![\w@.-])(@[\w.-]+\/[\w.-]+)((?:\/[\w@.+-]+)*)/g)){
   const workspace=workspaces.get(match[1]);if(!workspace)continue;
   for(const entry of workspace.entries)found.add(entry);
   // A subpath ('@edge-ffmpeg/x/src/y.js') names that file of the package as well.
   if(match[2])for(const path of pathReferences(`'.${match[2]}'`,`${workspace.directory}/package.json`,context))found.add(path);
  }
  return found;
 };
 // Scans a source once: its literal references, npm scripts and repository scans become edges. Returns new entries.
 const scanned=new Set(),entries=new Set(tests.filter(isModule));
 const scan=file=>{
  if(scanned.has(file)||!SCANNED.test(file))return [];
  scanned.add(file);const text=read(file),found=[];
  const targets=new Set(pathReferences(text,file,context));
  for(const name of scriptReferences(text,scripts))for(const path of pathsOfScript(name))targets.add(path);
  for(const path of workspaceReferences(text))targets.add(path);
  if(MODULE.test(file)&&REPOSITORY_SCAN.test(text))add(file,'.');
  for(const target of targets){
   add(file,target);
   const reached=directorySet.has(target)?under(target):[target];
   for(const item of reached){if(isModule(item)&&!entries.has(item)){entries.add(item);found.push(item);}else if(SCANNED.test(item)&&!scanned.has(item))found.push(item);}
  }
  return found;
 };
 // Entry points: every test, and every module a scanned source names or holds in a directory it names.
 const pending=[...tests];
 while(pending.length)pending.push(...scan(pending.pop()));
 const missing=[],realRoot=realpathSync(root);
 const plugin={name:'repository-graph',setup(builder){
  // Packages outside the workspace are not part of the graph.
  builder.onResolve({filter:/^[^./]/},args=>args.path.startsWith('@edge-ffmpeg/')?undefined:{path:args.path,external:true});
  // A relative import of a file the checkout does not have (a Wasm module copied next to a fixture at run time).
  builder.onResolve({filter:/^\.\.?\//},args=>{
   if(!args.resolveDir)return undefined;
   const path=resolve(args.resolveDir,args.path.replace(/[?#].*$/,''));
   if(importable(path))return undefined;
   missing.push({from:[realRoot,root].map(base=>relative(base,args.importer)).find(path=>!path.startsWith('..'))?.split('\\').join('/')??args.importer,path:args.path});return {path:args.path,external:true};
  });
 }};
 let bundles=0;
 const bundle=list=>{bundles++;return build({absWorkingDir:root,entryPoints:list,bundle:true,write:false,metafile:true,outdir:resolve(root,'.build/ci/graph'),platform:'node',format:'esm',logLevel:'silent',plugins:[plugin],
  loader:{'.wasm':'empty','.c':'empty','.h':'empty','.txt':'empty','.bin':'empty','.md':'empty','.sh':'empty','.py':'empty'}});};
 const failed=[],bundled=new Set();
 // A list that does not bundle is split in halves until each failing entry stands alone, so one entry that does not
 // bundle hides no other; a failing entry depends on everything.
 const bundleAll=async list=>{
  try{return (await bundle(list)).metafile.inputs;}
  catch(error){
   if(list.length===1){failed.push({entry:list[0],error:String(error.message??error).split('\n').slice(0,3).join(' ')});add(list[0],'.');return {};}
   const middle=Math.ceil(list.length/2),[left,right]=await Promise.all([bundleAll(list.slice(0,middle)),bundleAll(list.slice(middle))]);
   return {...left,...right};
  }
 };
 // Rounds: modules first found by scanning the bundled modules become entries of the next round.
 for(let round=0,todo=[...entries].filter(file=>existsSync(resolve(root,file))).sort();todo.length;round++){
  const inputs=await bundleAll(todo);
  for(const entry of todo)bundled.add(entry);for(const file of Object.keys(inputs))bundled.add(file);
  const next=new Set();
  for(const [file,input]of Object.entries(inputs)){
   if(file.startsWith('node_modules/')||!fileSet.has(file))continue;
   for(const imported of input.imports)if(!imported.external&&fileSet.has(imported.path))add(file,imported.path);
   for(const found of scan(file)){const queue=[found];while(queue.length){const item=queue.pop();if(isModule(item)&&!bundled.has(item))next.add(item);queue.push(...scan(item));}}
  }
  todo=[...next].filter(file=>existsSync(resolve(root,file))).sort();
  if(round>8&&todo.length)throw new Error(`the graph did not converge (${todo.length} new entries after ${round} rounds)`);
 }
 // Directories depend on what they hold; the repository on every file.
 for(const [directory,held]of contents)for(const file of held)add(directory,file);
 for(const file of files)add('.',file);
 return {edges,tests,failed,missing,sources:read,bundles};
}
/**
 * The affected tests of a change. changed: explicit changed files (otherwise from git against base). Returns
 * {base, mergeBase, changed, all, reasons: {test: [reason, ...]}, chains: {test: [node, ...]}, tests, graph details}.
 */
export async function affectedTests({root,base,files,config,changed:given=null,current}){
 const lane=config.fastLane,isGlobal=globMatcher(lane.allTestsWhenChanged);
 const found=given?{base:null,mergeBase:null,changed:[...given].sort()}:changedFiles(root,base,{notBases:lane.notBases??[],...(current===undefined?{}:{current})}),{mergeBase,changed}=found;
 base=found.base??base;
 const tests=SUITES.flatMap(suite=>suiteFiles(files,suite)),reasons={},chains={},select=(test,reason,chain=null)=>{(reasons[test]??=[]).push(reason);if(chain&&!chains[test])chains[test]=chain;};
 const summary={base,mergeBase,distance:found.distance??null,rejectedBases:found.rejected??[],changed};
 const everything=reason=>{for(const test of tests)select(test,reason);return {...summary,all:true,reasons,chains,tests:[...tests].sort()};};
 if(!changed)return everything(`no branch point among ${JSON.stringify(base)}`);
 const global=changed.filter(file=>isGlobal(file));
 if(global.length)return everything(`changed ${global.join(', ')}`);
 const nodes=[...new Set(files)].sort(),testSet=new Set(tests),nodeSet=new Set(nodes);
 for(const file of changed)if(testSet.has(file))select(file,'changed');
 for(const test of tests)if(basename(test).includes(lane.registryTest))select(test,'registry test');
 let graph;
 try{graph=await dependencyGraph(root,nodes,{tests});}catch(error){return everything(`the dependency graph failed: ${String(error.message??error).split('\n')[0]}`);}
 const importers=new Map();
 for(const [from,targets]of graph.edges)for(const to of targets){if(!importers.has(to))importers.set(to,new Set());importers.get(to).add(from);}
 const directories=directoriesOf(nodes);
 for(const file of changed){
  const starts=new Set([file]);
  if(!nodeSet.has(file)){
   // Deleted: the directories that held it, and every source that still names it (by path or by file name).
   let directory=posix.dirname(file);while(directory&&directory!=='.'){if(directories.has(directory))starts.add(directory);directory=posix.dirname(directory);}
   const stem=basename(file).replace(/\.[^.]+$/,'');
   if(stem.length>=3)for(const node of nodes)if(SCANNED.test(node)&&graph.sources(node).includes(stem))starts.add(node);
  }
  // Breadth first from the change to every source that depends on it; the first chain that reaches a test is kept.
  const previous=new Map([...starts].map(start=>[start,null])),queue=[...starts];
  const chain=node=>{const list=[];for(let item=node;item!==null&&item!==undefined;item=previous.get(item))list.push(item);return list;};
  for(const start of starts)if(testSet.has(start)&&start!==file)select(start,`names deleted ${file}`,[start]);
  while(queue.length){
   const node=queue.shift();
   for(const importer of importers.get(node)??[]){
    if(previous.has(importer))continue;previous.set(importer,node);
    if(testSet.has(importer))select(importer,`depends on ${file}`,chain(importer));
    queue.push(importer);
   }
  }
 }
 return {...summary,all:false,reasons,chains,tests:Object.keys(reasons).sort(),graphFailures:graph.failed,missingImports:graph.missing,bundles:graph.bundles};
}

if(import.meta.url===`file://${process.argv[1]}`){
 const {readConfig}=await import('./plan.mjs'),{snapshotSource}=await import('../compatibility-report/source.mjs');
 const root=resolve(import.meta.dirname,'../..'),args=process.argv.slice(2),config=readConfig(),option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]??null;};
 const changedAt=args.indexOf('--changed'),rest=changedAt>=0?args.slice(changedAt+1):[],end=rest.findIndex(arg=>arg.startsWith('--')),changed=changedAt>=0?(end<0?rest:rest.slice(0,end)):null;
 const selection=await affectedTests({root,base:option('--base')??config.fastLane.bases,files:snapshotSource(root).files.map(entry=>entry.file),config,changed});
 if(option('--json'))writeFileSync(resolve(process.env.INIT_CWD??process.cwd(),option('--json')),JSON.stringify(selection,null,1)+'\n');
 console.log(JSON.stringify({base:selection.base,mergeBase:selection.mergeBase,rejectedBases:selection.rejectedBases,changed:selection.changed,all:selection.all,count:selection.tests.length,graphFailures:selection.graphFailures,missingImports:selection.missingImports?.length},null,1));
 for(const test of selection.tests)console.log(`${test}: ${[...new Set(selection.reasons[test])].slice(0,3).join('; ')}${selection.chains[test]?.length>1?` (via ${selection.chains[test].slice(1).join(' -> ')})`:''}`);
}
