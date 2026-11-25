// Local Linux x86_64 loop in the pinned image (compat/reference-container.lock.json), usually Docker Desktop under
// Rosetta. Its results are drafts: committed Linux evidence comes only from GitHub's real-hardware jobs.
//   npm run linux:test -- [--label <name>] <test files...>     selected tests as uid 1000, reports in .build/linux-green/<name>/
//   npm run linux:corpora -- --draft [--label <name>] [--only id,...]   draft corpora in .build/linux-green/drafts/
//   node tools/linux/container-run.mjs bootstrap | install | exec -- <command...>
// Options: --reference <dir> (default .build/linux-x64/reference, built by npm run reference:build:linux).
// The checkout is mounted read-only at /workspace with a writable scratch .build (.build/linux-green/container/build),
// the verified linux-x64 reference read-only at /workspace/.build/reference, a Linux node_modules
// (.build/linux-green/container/node_modules, installed by a networked npm ci keyed by package-lock.json) and a tmpfs
// /tmp, so permission and errno tests see Linux semantics rather than the virtiofs bind mount. No network otherwise.
import {spawnSync,execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {localReferenceIdentity,sha256,sha256File} from '../differential-runner/reference-identity.mjs';

const root=resolve(import.meta.dirname,'../..'),lock=JSON.parse(readFileSync(resolve(root,'compat/reference-container.lock.json'),'utf8'));
if(!/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/.test(lock.image)||lock.platform!=='linux/amd64')throw new Error('Invalid compat/reference-container.lock.json');
const usage='Usage: node tools/linux/container-run.mjs test [--label <name>] <files...> | corpora --draft [--label <name>] [--only ids] | bootstrap | install | exec -- <command...>  [--reference <dir>]';
const [command,...rest]=process.argv.slice(2);
const option=name=>{const at=rest.indexOf(name);if(at<0)return null;const value=rest[at+1];if(!value||value.startsWith('--'))throw new Error(`${name} needs a value`);rest.splice(at,2);return value;};
const flag=name=>{const at=rest.indexOf(name);if(at<0)return false;rest.splice(at,1);return true;};
const container=resolve(root,'.build/linux-green/container'),scratch=join(container,'build'),modules=join(container,'node_modules'),npmCache=join(container,'npm-cache');
const inside=(path,parent)=>{const local=relative(parent,path);return local===''||!local.startsWith('..')&&!isAbsolute(local);};
const label=option('--label'),referenceOption=option('--reference');
if(label!==null&&!/^[\w.-]+$/.test(label))throw new Error('--label must be a plain name');

function docker(args,{capture=false}={}){
 const result=spawnSync('docker',args,{cwd:root,stdio:capture?['ignore','pipe','inherit']:'inherit',encoding:'utf8'});
 if(result.error)throw new Error(`docker is unavailable: ${result.error.message}`);
 return result;
}
const mount=(src,dst,readonly=false)=>['--mount',`type=bind,src=${src},dst=${dst}${readonly?',readonly':''}`];

/** The verified linux-x64 reference directory (realpath) and its identity. */
function linuxReference(){
 const dir=resolve(root,referenceOption??'.build/linux-x64/reference');
 if(!existsSync(join(dir,'build-metadata.json')))throw new Error(`No Linux reference at ${relative(root,dir)||dir}; build it with npm run reference:build:linux or pass --reference <dir>`);
 const real=realpathSync(dir),identity=localReferenceIdentity(root,{dir:real,host:{platform:'linux',arch:'x64'}});
 return {dir:real,identity};
}
/** Hash-verified Wasm modules copied into the scratch .build. */
function stageCodecs(){
 const h264=JSON.parse(readFileSync(resolve(root,'tools/codecs/openh264/build.lock.json'),'utf8')),flac=JSON.parse(readFileSync(resolve(root,'tools/codecs/flac/inputs.json'),'utf8'));
 const modules={'codecs/openh264/openh264.wasm':h264.expectedWasmSha256,'codecs/flac/edge-flac.wasm':flac.wasmSha256},staged={};
 for(const [path,expected]of Object.entries(modules)){
  const source=resolve(root,'.build',path);if(!existsSync(source))throw new Error(`Missing .build/${path}; run npm run bootstrap`);
  const actual=sha256File(source);if(actual!==expected)throw new Error(`.build/${path} ${actual.slice(0,12)} differs from its lock ${expected.slice(0,12)}`);
  const target=join(scratch,path);if(!existsSync(target)||sha256File(target)!==expected){mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);}
  staged[path]=expected;
 }
 return staged;
}
/** Absolute host paths outside the checkout that git needs inside the container, mounted read-only at the same path. */
function externalMounts(){
 const paths=new Set();
 const common=execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:root,encoding:'utf8'}).trim();
 if(!inside(realpathSync(common),root))paths.add(realpathSync(common));
 const upstream=resolve(root,'upstream/ffmpeg');if(existsSync(upstream)){const real=realpathSync(upstream);if(!inside(real,root))paths.add(real);}
 return [...paths].flatMap(path=>mount(path,path,true));
}
const lockKey=()=>sha256(readFileSync(resolve(root,'package-lock.json'))+'\n'+lock.image);
function install(force=false){
 const marker=join(modules,'.edge-ffmpeg-install');
 if(!force&&existsSync(marker)&&readFileSync(marker,'utf8')===lockKey())return;
 mkdirSync(modules,{recursive:true});mkdirSync(npmCache,{recursive:true});
 console.log('[linux] installing the Linux node_modules (networked npm ci)');
 const result=docker(['run','--rm','--platform',lock.platform,'--user','1000:1000','--tmpfs','/tmp:exec,mode=1777','-e','HOME=/tmp/home','-e','npm_config_cache=/npm-cache',
  ...mount(root,'/workspace',true),...mount(modules,'/workspace/node_modules'),...mount(npmCache,'/npm-cache'),'-w','/workspace',lock.image,'npm','ci','--no-audit','--no-fund']);
 if(result.status!==0)throw new Error(`npm ci in the container failed (${result.status??result.signal})`);
 writeFileSync(marker,lockKey());
}
/** Runs argv in the pinned image as uid 1000 without network; results is an optional host directory mounted at /results. */
function run(argv,{results=null}={}){
 const reference=linuxReference(),codecs=stageCodecs();install();
 mkdirSync(join(scratch,'reference'),{recursive:true});const drafts=resolve(root,'.build/linux-green/drafts');mkdirSync(drafts,{recursive:true});mkdirSync(join(scratch,'linux-green/drafts'),{recursive:true});
 const args=['run','--rm','--platform',lock.platform,'--user','1000:1000','--network','none','--tmpfs','/tmp:exec,mode=1777',
  '-e','HOME=/tmp/home','-e','GIT_CONFIG_COUNT=1','-e','GIT_CONFIG_KEY_0=safe.directory','-e','GIT_CONFIG_VALUE_0=*','-e',`EDGEFFMPEG_CONTAINER_IMAGE=${lock.image}`,
  ...mount(root,'/workspace',true),...mount(scratch,'/workspace/.build'),...mount(reference.dir,'/workspace/.build/reference',true),...mount(drafts,'/workspace/.build/linux-green/drafts'),
  ...mount(modules,'/workspace/node_modules'),...externalMounts(),...(results?mount(results,'/results'):[]),'-w','/workspace',lock.image,...argv];
 if(results)writeFileSync(join(results,'container-run.json'),JSON.stringify({image:lock.image,platform:lock.platform,reference:{dir:reference.dir,id:reference.identity.id,ffmpeg:reference.identity.ffmpeg,ffprobe:reference.identity.ffprobe},codecs,argv,draftOnly:true,startedAt:new Date().toISOString()},null,2)+'\n');
 console.log(`[linux] ${reference.identity.id} reference ${reference.identity.ffmpeg.slice(0,12)}; ${argv.join(' ')}`);
 return docker(args).status??1;
}
const bootstrap=()=>run(['node','tools/bootstrap/bootstrap.mjs','--only','flac-investigation']);
const resultsDir=name=>{const dir=resolve(root,'.build/linux-green',name);mkdirSync(dir,{recursive:true});return dir;};

let status=0;
if(command==='install')install(true);
else if(command==='bootstrap')status=bootstrap();
else if(command==='test'){
 if(!rest.length)throw new Error(usage);
 status=bootstrap();
 if(status===0)status=run(['node','tools/linux/probe.mjs','run','--out','/results',...rest],{results:resultsDir(label??'linux-test')});
}else if(command==='corpora'){
 if(!flag('--draft'))throw new Error('Local container corpora are drafts only: pass --draft (committed Linux corpora come from the linux-corpora job)');
 const only=option('--only');if(rest.length)throw new Error(usage);
 status=bootstrap();
 if(status===0)status=run(['node','tools/linux/generate-corpora.mjs','--draft',...(only?['--only',only]:[])],{results:resultsDir(label??'linux-corpora')});
}else if(command==='exec'){
 const at=rest.indexOf('--');if(at<0||at===rest.length-1)throw new Error(usage);
 status=run(rest.slice(at+1),{results:label?resultsDir(label):null});
}else{console.error(usage);status=2;}
process.exitCode=status;
