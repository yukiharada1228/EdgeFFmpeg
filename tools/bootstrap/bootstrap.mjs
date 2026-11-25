// Reproducible development bootstrap: pinned sources, Native reference, Wasm codecs and generated test inputs.
// Every step verifies before it builds, builds only from pinned inputs and verifies again; see docs/contributing/environment-setup.md.
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,rmdirSync,copyFileSync,symlinkSync,openSync,writeSync,closeSync,realpathSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,dirname,join,relative,basename} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {platform,arch} from 'node:os';

// One row per bootstrap output, in execution order: needs names earlier steps that must be ready before it builds, tools the commands its build runs.
// A new generated input is one row here, its verify and build functions below and its pin in tools/bootstrap/lock.json.
const definitions=[
 {id:'npm',verify:verifyNpm,build:buildNpm,needs:[],tools:['npm']},
 {id:'submodule',verify:verifySubmodule,build:buildSubmodule,needs:[],tools:['git']},
 {id:'reference',verify:verifyReference,build:buildReference,needs:['submodule'],tools:['git','cc','make']},
 {id:'openh264',verify:verifyOpenh264,build:buildOpenh264,needs:[],tools:['git','bash','make','python3']},
 {id:'flac',verify:verifyFlac,build:buildFlac,needs:[],tools:['git','bash','python3','cmake','tar']},
 {id:'flac-investigation',verify:verifyInvestigation,build:buildInvestigation,needs:['reference','flac'],tools:[]}
];
const steps=definitions.map(step=>step.id);
for(const [index,step]of definitions.entries())if(typeof step.id!=='string'||steps.indexOf(step.id)!==index||typeof step.verify!=='function'||typeof step.build!=='function'||!Array.isArray(step.tools)||!Array.isArray(step.needs)||step.needs.some(id=>!steps.slice(0,index).includes(id)))throw Error(`Bootstrap step ${step.id}: needs a unique id, verify and build functions, a tools list and needs naming earlier steps`);

const here=import.meta.dirname,root=resolve(here,'../..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const show=path=>{const local=relative(root,path);return local&&!local.startsWith('..')?local:path;};
const json=path=>{const file=resolve(root,path);try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){throw Error(`${show(file)} is unreadable: ${error.message}`);}};
const lock=json('tools/bootstrap/lock.json'),upstream=json('compat/upstream.lock.json'),h264=json('tools/codecs/openh264/build.lock.json'),flac=json('tools/codecs/flac/inputs.json');
const host=`${platform()}-${arch()}`,components=['avfilter','avformat','avcodec','swscale','swresample','avutil'];
const usage='Usage: node tools/bootstrap/bootstrap.mjs [--check] [--offline] [--only <step,...>] [--emsdk <dir>] [--ffmpeg-source <git dir|url>] [--openh264-source <git dir|url>] [--flac-archive <file>] [--allow-unpinned-reference]\nSteps: '+steps.join(', ');
const options={only:null},args=process.argv.slice(2),userPath=path=>resolve(process.env.INIT_CWD??process.cwd(),path);
for(let i=0;i<args.length;i++){
 const name=args[i],value=args[i+1];
 if(name==='--help'){console.log(usage);process.exit(0);}
 if(['--check','--offline','--allow-unpinned-reference'].includes(name)){options[name.slice(2)]=true;continue;}
 if(!['--only','--emsdk','--ffmpeg-source','--openh264-source','--flac-archive'].includes(name)||!value||value.startsWith('--')||Object.hasOwn(options,name.slice(2))&&options[name.slice(2)]!==null){console.error(usage);process.exit(2);}
 options[name.slice(2)]=value;i++;
}
if(options.only){options.only=new Set(options.only.split(','));for(const id of options.only)if(!steps.includes(id)){console.error('Unknown step: '+id+'\n'+usage);process.exit(2);}}
if(h264.emsdkCommit!==flac.emsdkCommit||h264.emscriptenVersion!==flac.emsdkVersion)throw Error('OpenH264 and libFLAC build locks disagree on the emsdk pin');
const log=message=>console.log('[bootstrap] '+message),stamp=new Date().toISOString().replace(/[:.]/g,'-'),work=resolve(root,'.build/bootstrap'),logs=resolve(work,'logs'),staleDir=resolve(work,'stale');
const ok=(detail,extra={})=>({ok:true,status:'ok',detail,...extra}),fail=(status,detail,extra={})=>({ok:false,status,detail,...extra});
// A verify function that throws, for example on a truncated JSON output, reports a mismatch so the output is moved aside and rebuilt like any other.
const inspect=step=>{try{return step.verify();}catch(error){return fail('mismatch',error.message);}};
const git=(cwd,...argv)=>execFileSync('git',argv,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const tryGit=(cwd,...argv)=>{try{return git(cwd,...argv);}catch{return null;}};
const isUrl=value=>/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
function network(what,option){if(options.offline)throw Error(`Offline mode: ${what} would need a download; supply ${option} or run without --offline`);log('downloading '+what);}
function staleTarget(path){const local=relative(root,path);if(!local||local.startsWith('..'))throw Error('Refusing to move '+path+' outside this checkout');const to=resolve(staleDir,stamp,local);mkdirSync(dirname(to),{recursive:true});return to;}
function moveAside(path){const to=staleTarget(path);renameSync(path,to);log(`moved stale ${show(path)} to ${show(to)}`);}
// Codec output directories: the module and its build evidence are kept in stale/; the subdirectories (staged source, build tree, Emscripten cache copy) are regenerated by every build and deleted.
function clearOutput(dir){
 if(!existsSync(dir))return;const entries=readdirSync(dir,{withFileTypes:true}),files=entries.filter(entry=>!entry.isDirectory()).map(entry=>entry.name),dirs=entries.filter(entry=>entry.isDirectory()).map(entry=>entry.name);
 for(const name of files)renameSync(join(dir,name),staleTarget(join(dir,name)));rmSync(dir,{recursive:true,force:true});
 log(`${show(dir)}: moved ${files.length} stale file(s) to ${show(resolve(staleDir,stamp,relative(root,dir)))}${dirs.length?'; deleted regenerable '+dirs.join(', '):''}`);
}
function staleBytes(){let bytes=0;if(existsSync(staleDir))for(const path of readdirSync(staleDir,{recursive:true})){try{const stat=lstatSync(resolve(staleDir,path));if(stat.isFile())bytes+=stat.size;}catch{/* removed meanwhile */}}return bytes;}
function run(name,file,argv,cwd=root){
 mkdirSync(logs,{recursive:true});const path=resolve(logs,name+'.log'),fd=openSync(path,'a');
 try{writeSync(fd,`$ (cd ${cwd} && ${[file,...argv].join(' ')})\n`);const result=spawnSync(file,argv,{cwd,stdio:['ignore',fd,fd]});
  if(result.error||result.status!==0)throw Error(`${[basename(file),...argv].slice(0,2).join(' ')} failed (${result.error?.message??'exit '+(result.status??result.signal)}); log: ${relative(root,path)}\n`+readFileSync(path,'utf8').split('\n').slice(-30).join('\n'));}
 finally{closeSync(fd);}
}
function tool(command,args=['--version']){const result=spawnSync(command,args,{encoding:'utf8'});return result.error||result.status!==0?null:(result.stdout||result.stderr).split('\n')[0].trim();}
function requireTools(step){const missing=step.tools.filter(command=>!tool(command));if(missing.length)throw Error(`${step.id} needs ${missing.join(', ')} on PATH`);}

// npm: node_modules must hold exactly the locked versions; npm ci reinstalls otherwise.
function verifyNpm(){
 const hidden=resolve(root,'node_modules/.package-lock.json');if(!existsSync(hidden))return npmFail('missing','node_modules is not installed');
 const locked=json('package-lock.json').packages,installed=json('node_modules/.package-lock.json').packages??{};let count=0;
 for(const [name,entry]of Object.entries(locked)){if(!name.startsWith('node_modules/'))continue;const actual=installed[name];
  if(!actual){if(entry.optional||entry.devOptional)continue;return npmFail('stale',name+' is not installed');}
  if(entry.version!==actual.version||!existsSync(resolve(root,name)))return npmFail('stale',`${name} differs from package-lock.json`);count++;}
 return ok(`${count} locked packages installed`);
}
// Locked tarballs npm ci certainly installs on this host but the npm cache (content-v2, addressed by sha512 integrity) lacks; null when npm is unavailable.
// Conservative: libc-specific builds and optional peers without a platform are skipped, so npm can still report ENOTCACHED for those.
function npmCacheGaps(){
 const cache=tool('npm',['config','get','cache']);if(!cache)return null;
 const fits=(list,value)=>!list||(list.some(item=>!item.startsWith('!'))?list.includes(value):!list.includes('!'+value));
 return Object.entries(json('package-lock.json').packages).filter(([name,entry])=>{
  if(!name.startsWith('node_modules/')||entry.link||!entry.integrity?.startsWith('sha512-')||entry.libc||!fits(entry.os,platform())||!fits(entry.cpu,arch())||entry.optional&&entry.peer&&!entry.os&&!entry.cpu)return false;
  const hex=Buffer.from(entry.integrity.split(/\s+/)[0].slice(7),'base64').toString('hex');return !existsSync(join(cache,'_cacache/content-v2/sha512',hex.slice(0,2),hex.slice(2,4),hex.slice(4)));
 }).map(([name,entry])=>`${name.slice(name.lastIndexOf('node_modules/')+13)}@${entry.version}`);
}
const offlineNpmHint='run npm ci once online to fill the npm cache, or run the bootstrap without --offline';
function npmFail(status,detail){const gaps=npmCacheGaps();return fail(status,detail+(gaps===null?'':gaps.length?`; the npm cache lacks ${gaps.length} locked package(s), so --offline would fail`:'; the npm cache holds the locked packages this host installs'));}
function buildNpm(){
 if(options.offline){const gaps=npmCacheGaps();if(gaps?.length)throw Error(`Offline mode: npm ci needs ${gaps.length} locked package(s) that the npm cache lacks (${gaps.slice(0,3).join(', ')}${gaps.length>3?', ...':''}); ${offlineNpmHint}`);}
 try{run('npm','npm',['ci','--no-audit','--no-fund',...(options.offline?['--offline']:[])]);}
 catch(error){throw options.offline&&/ENOTCACHED/.test(error.message)?Error(`${error.message}\nOffline mode: the npm cache lacks a package npm ci needs; ${offlineNpmHint}`):error;}
}

// Submodule: pinned commit, clean tree, and the release tag reachable so FFmpeg's version.sh embeds the same version string.
const submodule=lock.submodule.path,submoduleDir=resolve(root,submodule);
function verifySubmodule(){
 const gitlink=tryGit(root,'ls-tree','HEAD',submodule)?.split(/\s+/)[2];if(gitlink!==upstream.commit)return fail('inconsistent',`superproject gitlink ${gitlink} differs from compat/upstream.lock.json ${upstream.commit}`);
 if(!existsSync(resolve(submoduleDir,'.git')))return fail('missing',submodule+' is not initialised');
 const head=tryGit(submoduleDir,'rev-parse','HEAD');if(head!==upstream.commit)return fail('mismatch',`${submodule} is at ${head}, expected ${upstream.commit}`);
 if(tryGit(submoduleDir,'status','--porcelain','--untracked-files=no'))return fail('modified',submodule+' has local changes');
 const described=tryGit(submoduleDir,'describe','--tags','--always');if(described!==upstream.tag)return fail('untagged',`git describe gives ${described}, expected ${upstream.tag}; FFmpeg would embed a different version string`);
 return ok(`${submodule} at ${upstream.commit.slice(0,12)} (${upstream.tag}), clean`);
}
function buildSubmodule(state){
 if(['mismatch','modified','inconsistent'].includes(state.status))throw Error(`Refusing to modify ${submodule}: ${state.detail}. Restore it to ${upstream.commit} manually`);
 const url=git(root,'config','-f','.gitmodules',`submodule.${submodule}.url`),source=options['ffmpeg-source'],local=source&&!isUrl(source),from=local?userPath(source):source??url;
 if(url!==lock.submodule.url)throw Error('.gitmodules URL differs from tools/bootstrap/lock.json');
 if(!local)network(`FFmpeg ${upstream.tag} from ${from}`,'--ffmpeg-source <local FFmpeg git checkout>');
 if(state.status==='missing'){
  git(root,'submodule','init',submodule);
  try{git(root,'config',`submodule.${submodule}.url`,from);run('submodule','git',['-c','protocol.file.allow=always','submodule','update',...(local?[]:['--depth','1']),submodule]);}
  finally{git(root,'config',`submodule.${submodule}.url`,url);if(existsSync(resolve(submoduleDir,'.git')))git(submoduleDir,'remote','set-url','origin',url);}
 }
 if(tryGit(submoduleDir,'describe','--tags','--always')!==upstream.tag){
  const shallow=git(submoduleDir,'rev-parse','--is-shallow-repository')==='true';
  run('submodule','git',['fetch','--no-tags',...(shallow?['--depth','1']:[]),from,`refs/tags/${upstream.tag}:refs/tags/${upstream.tag}`],submoduleDir);
 }
}

// Reference: rebuilt in place when absent, inconsistent or different from this host's pin. Host pins are platforms[host] of the record lock.json reference.pins names (compat/reference-pins.json).
// The macOS linker does not always lay out identical inputs identically (duplicate local absolute assembler symbols), so an off-pin link is relinked serially.
const referenceDir=resolve(root,'.build/reference'),programs=['ffmpeg_g','ffmpeg','ffprobe_g','ffprobe'],relinkAttempts=6;
const configureFlags=()=>readFileSync(resolve(root,upstream.configureFile),'utf8').trim().split(/\s+/);
let pinned;
function referencePin(){
 if(pinned!==undefined)return pinned;const file=lock.reference.pins,pins=json(file),digest=/^[0-9a-f]{64}$/;
 if(pins.schemaVersion!==1||pins.commit!==upstream.commit||pins.tag!==upstream.tag||JSON.stringify(pins.flags)!==JSON.stringify(configureFlags()))throw Error(`${file} no longer pins ${upstream.tag} ${upstream.commit} built with ${upstream.configureFile}; update it or reference.pins in tools/bootstrap/lock.json`);
 const record=Object.hasOwn(pins.platforms??{},host)?pins.platforms[host]:null;if(!record)return pinned=null;
 if(record.platform!==platform()||record.arch!==arch()||!digest.test(record.artifacts?.ffmpeg)||!digest.test(record.artifacts?.ffprobe))throw Error(`${file} platforms.${host} is not a ${host} reference pin`);
 const libraries=record.libraries&&typeof record.libraries==='object'?Object.entries(record.libraries):[];
 if(!libraries.length||libraries.some(([path,value])=>!/^lib\w+\/lib\w+\.a$/.test(path)||!digest.test(value)))throw Error(`${file} platforms.${host} must pin the sha256 of every oracle link library`);
 return pinned={ffmpeg:record.artifacts.ffmpeg,ffprobe:record.artifacts.ffprobe,libraries:Object.fromEntries(libraries),file,compiler:String(record.compiler??'an unrecorded compiler').split('\n')[0]};
}
// Every pinned static library: the oracles and corpus generators link these, so programs that match the pin are not enough.
function libraryMismatches(pin){
 return Object.entries(pin.libraries).flatMap(([path,expected])=>{const file=resolve(referenceDir,path);if(!existsSync(file))return [`${path} is missing`];const actual=sha(readFileSync(file));return actual===expected?[]:[`${path} ${actual.slice(0,12)} is not the pinned ${expected.slice(0,12)}`];});
}
// Every ffmpeg hash pinned in the reference pins: a reference listed there must have content-pinned FLAC investigation outputs.
function pinnedFfmpegHashes(){const pins=json(lock.reference.pins);return new Set(Object.values(pins.platforms??{}).map(record=>record?.artifacts?.ffmpeg).filter(Boolean));}
const programHashes=()=>Object.fromEntries(['ffmpeg','ffprobe'].map(name=>[name,sha(readFileSync(resolve(referenceDir,name)))]));
const pair=hashes=>`${hashes.ffmpeg.slice(0,12)}/${hashes.ffprobe.slice(0,12)}`;
// Digest of what the programs link: every lib*/lib*.a and fftools object, as `shasum -a 256` lines sorted by path.
function linkInputs(){
 if(!existsSync(resolve(referenceDir,'fftools')))return null;
 const files=[...readdirSync(referenceDir).filter(name=>/^lib\w+$/.test(name)&&existsSync(resolve(referenceDir,name,name+'.a'))).map(name=>`${name}/${name}.a`),...readdirSync(resolve(referenceDir,'fftools'),{recursive:true}).filter(path=>path.endsWith('.o')).map(path=>'fftools/'+path)].sort();
 return sha(files.map(path=>`${sha(readFileSync(resolve(referenceDir,path)))}  ${path}\n`).join(''));
}
function linkDiagnosis(pin,compiler){
 const expected=lock.reference.linkInputs[pin.ffmpeg];if(!expected)return `no link-input digest is pinned for it; this host compiles with ${compiler}, the pin was built with ${pin.compiler}`;
 return linkInputs()===expected?'the libraries and fftools objects match the pinned link inputs, so only the nondeterministic macOS link differs; npm run bootstrap relinks the programs':`the libraries or fftools objects differ from the pinned link inputs, so this host compiles differently: ${compiler}, while the pin was built with ${pin.compiler}`;
}
function verifyReference(){
 if(!['ffmpeg','ffprobe','build-metadata.json'].every(name=>existsSync(resolve(referenceDir,name))))return fail('missing','.build/reference is not built');
 const metadata=json('.build/reference/build-metadata.json'),actual=programHashes();
 if(metadata.commit!==upstream.commit||JSON.stringify(metadata.flags)!==JSON.stringify(configureFlags())||metadata.platform!==platform()||metadata.arch!==arch())return fail('inconsistent','build-metadata.json does not match the pinned commit, configure flags or this host');
 for(const name of ['ffmpeg','ffprobe'])if(metadata.artifacts?.[name]!==actual[name])return fail('inconsistent',`${name} differs from build-metadata.json`);
 const missing=[...components.map(part=>`lib${part}/lib${part}.a`),'ffbuild/config.mak','config.h'].filter(path=>!existsSync(resolve(referenceDir,path)));
 if(missing.length)return fail('incomplete','oracle link inputs missing: '+missing.join(', '));
 const pin=referencePin(),summary=`ffmpeg ${actual.ffmpeg.slice(0,12)} ffprobe ${actual.ffprobe.slice(0,12)}`,accept=options['allow-unpinned-reference'];
 if(!pin){const detail=`${summary}; no reference pin exists for ${host} in compat/reference-pins.json, so tests that resolve the pinned reference cannot pass on this host`;return accept?ok(detail+'; accepted by --allow-unpinned-reference',{warning:`unpinned reference on ${host}`}):fail('unpinned',detail+'; --allow-unpinned-reference accepts it');}
 if(pin.ffmpeg===actual.ffmpeg&&pin.ffprobe===actual.ffprobe){
  const libraries=libraryMismatches(pin);if(!libraries.length)return ok(`${summary} and the ${Object.keys(pin.libraries).length} pinned libraries match the ${host} pin in ${pin.file}`);
  const detail=`${summary} match the ${host} pin in ${pin.file}, but its libraries do not: ${libraries.join('; ')}`;
  return accept?ok(detail+'; accepted by --allow-unpinned-reference',{warning:'reference libraries differ from the pin; oracles and corpora linked against them are not pinned evidence'}):fail('mismatch',detail);
 }
 const detail=`${summary} differ from the ${host} pin ${pair(pin)} in ${pin.file}; ${linkDiagnosis(pin,String(metadata.compiler??'an unrecorded compiler').split('\n')[0])}`;
 return accept?ok(detail+'; accepted by --allow-unpinned-reference',{warning:`reference differs from the pin; tests that pin ffmpeg ${pin.ffmpeg.slice(0,12)} will fail`}):fail('mismatch',detail);
}
function buildReference(state){
 const pin=referencePin(),accept=options['allow-unpinned-reference'];
 if(!pin&&!accept)throw Error(`no reference pin exists for ${host} in compat/reference-pins.json, so tests that resolve the pinned reference cannot pass here; pass --allow-unpinned-reference to build and accept an unpinned reference`);
 // make treats existing programs as up to date, so they are deleted and relinked; libraries and objects are rebuilt incrementally in place.
 if(state.status!=='missing')for(const name of programs)rmSync(resolve(referenceDir,name),{force:true});
 run('reference',process.execPath,['tools/upstream-build/build.mjs']);
 if(!pin)return;
 let actual=programHashes();const matches=()=>actual.ffmpeg===pin.ffmpeg&&actual.ffprobe===pin.ffprobe;if(matches())return;
 const expected=lock.reference.linkInputs[pin.ffmpeg],inputs=linkInputs(),outcomes=new Set([pair(actual)]);
 if(expected&&inputs!==expected)return;// compiled code differs from the pin's, so no relink can match; verification reports the compiler
 for(let attempt=1;attempt<=relinkAttempts&&!matches();attempt++){
  log(`reference: the link gave ${pair(actual)}, not the ${host} pin ${pair(pin)}; relinking ffmpeg and ffprobe one at a time (${attempt}/${relinkAttempts})`);
  for(const name of programs)rmSync(resolve(referenceDir,name),{force:true});for(const program of ['ffmpeg','ffprobe'])run('reference','make',[program],referenceDir);
  if(linkInputs()!==inputs)throw Error('the link inputs changed while only the programs were relinked; see .build/bootstrap/logs/reference.log');
  actual=programHashes();outcomes.add(pair(actual));
 }
 if(!matches()&&!accept)throw Error(`${relinkAttempts+1} links of unchanged inputs gave ${[...outcomes].join(', ')} (ffmpeg/ffprobe), never the ${host} pin ${pair(pin)} from ${pin.file}. `+(expected?'The inputs match the pinned link inputs, so this host links differently: compare ld -v with the linker that built the pin':`This host compiles with ${tool('cc')}; the pin was built with ${pin.compiler}`)+`. --allow-unpinned-reference accepts this reference, but tests that pin ffmpeg ${pin.ffmpeg.slice(0,12)} then fail`);
 run('reference',process.execPath,['tools/upstream-build/build.mjs']);// configure plus a no-op make rewrite build-metadata.json for the relinked programs
}

// Emscripten SDK shared by both codecs; the default checkout is created only when absent.
let emsdkDir=null;
function emsdkState(dir){
 if(!existsSync(resolve(dir,'emsdk')))return fail('missing',show(dir)+' is not an emsdk checkout');
 const top=tryGit(dir,'rev-parse','--show-toplevel'),head=tryGit(dir,'rev-parse','HEAD');
 if(!top||realpathSync(top)!==realpathSync(dir)||head!==h264.emsdkCommit)return fail('mismatch',`emsdk must be its own checkout at ${h264.emsdkCommit}, found ${head}`);
 if(tryGit(dir,'status','--porcelain','--untracked-files=no'))return fail('modified','emsdk checkout has local changes');
 const version=resolve(dir,'upstream/emscripten/emscripten-version.txt');
 if(!existsSync(version)||readFileSync(version,'utf8').trim()!==JSON.stringify(h264.emscriptenVersion))return fail('uninstalled',`Emscripten ${h264.emscriptenVersion} is not installed`);
 if(!existsSync(resolve(dir,'.emscripten')))return fail('inactive',`Emscripten ${h264.emscriptenVersion} is installed but not activated`);
 const expected=readFileSync(resolve(root,'tools/codecs/flac/evidence/compiler.txt'),'utf8').split('\n')[0],actual=spawnSync('bash',['-c','set +u;source "$1/emsdk_env.sh" >/dev/null 2>&1;emcc --version','emsdk',dir],{encoding:'utf8'}).stdout?.split('\n')[0];
 if(actual!==expected)return fail('mismatch',`emcc reports "${actual}", expected "${expected}"`);
 return ok(`${show(dir)} at ${h264.emsdkCommit.slice(0,12)}, ${actual.replace(/^.*\) /,'emcc ')}`);
}
function ensureEmsdk(){
 if(emsdkDir)return emsdkDir;
 const dir=options.emsdk?userPath(options.emsdk):resolve(root,lock.emsdk.directory);let state=emsdkState(dir);
 if(state.status==='missing'&&!options.emsdk){
  network(`emsdk ${h264.emsdkCommit} from ${lock.emsdk.url}`,'--emsdk <pinned emsdk checkout>');if(existsSync(dir))moveAside(dir);mkdirSync(dir,{recursive:true});
  for(const argv of [['init','--quiet'],['fetch','--quiet','--depth=1',lock.emsdk.url,h264.emsdkCommit],['checkout','--quiet','--detach','FETCH_HEAD']])run('emsdk','git',argv,dir);state=emsdkState(dir);
 }
 if(state.status==='uninstalled'&&!options.emsdk){network(`Emscripten ${h264.emscriptenVersion} through emsdk install`,'--emsdk <installed emsdk checkout>');run('emsdk',resolve(dir,'emsdk'),['install',h264.emscriptenVersion],dir);state=emsdkState(dir);}
 if(state.status==='inactive'){run('emsdk',resolve(dir,'emsdk'),['activate',h264.emscriptenVersion],dir);state=emsdkState(dir);}
 if(!state.ok)throw Error('emsdk: '+state.detail);
 log('emsdk '+state.detail);return emsdkDir=dir;
}

// OpenH264: a clean shallow checkout of the pinned commit, fetched from a local repository or the pinned URL.
const h264Wasm=resolve(root,'.build/codecs/openh264/openh264.wasm');
function verifyOpenh264(){
 if(!existsSync(h264Wasm))return fail('missing','.build/codecs/openh264/openh264.wasm is not built');
 const digest=sha(readFileSync(h264Wasm));return digest===h264.expectedWasmSha256?ok('openh264.wasm matches build.lock.json '+digest.slice(0,12)):fail('mismatch',`openh264.wasm ${digest.slice(0,12)} differs from ${h264.expectedWasmSha256.slice(0,12)}`);
}
function ensureOpenh264Source(){
 const dir=resolve(root,lock.openh264.directory);
 if(existsSync(dir)){if(tryGit(dir,'rev-parse','HEAD')===h264.sourceCommit&&!tryGit(dir,'status','--porcelain','--untracked-files=no')&&realpathSync(git(dir,'rev-parse','--show-toplevel'))===realpathSync(dir))return dir;moveAside(dir);}
 const source=options['openh264-source'],from=source?(isUrl(source)?source:userPath(source)):lock.openh264.url;
 if(!source||isUrl(source))network(`OpenH264 ${h264.sourceCommit} from ${from}`,'--openh264-source <git repository containing the pinned commit>');
 mkdirSync(dir,{recursive:true});for(const argv of [['init','--quiet'],['fetch','--quiet','--depth=1',from,h264.sourceCommit],['checkout','--quiet','--detach','FETCH_HEAD']])run('openh264','git',argv,dir);
 if(git(dir,'rev-parse','HEAD')!==h264.sourceCommit)throw Error('OpenH264 checkout is not the pinned commit');return dir;
}
function buildOpenh264(){
 const emsdk=ensureEmsdk(),source=ensureOpenh264Source();clearOutput(dirname(h264Wasm));
 run('openh264',process.execPath,['tools/codecs/openh264/build.mjs','--source',source,'--emsdk',emsdk]);
}

// libFLAC: the official release archive, verified by SHA-256 before extraction and again member-by-member by build.py.
const flacWasm=resolve(root,'.build/codecs/flac/edge-flac.wasm');
function verifyFlac(){
 if(!existsSync(flacWasm))return fail('missing','.build/codecs/flac/edge-flac.wasm is not built');
 const bytes=readFileSync(flacWasm),digest=sha(bytes);return digest===flac.wasmSha256&&bytes.length===flac.wasmBytes?ok(`edge-flac.wasm matches inputs.json ${digest.slice(0,12)} (${bytes.length} bytes)`):fail('mismatch',`edge-flac.wasm ${digest.slice(0,12)} (${bytes.length} bytes) differs from ${flac.wasmSha256.slice(0,12)}`);
}
async function ensureFlacArchive(){
 const target=resolve(root,lock.flac.archive),given=options['flac-archive']&&userPath(options['flac-archive']);mkdirSync(dirname(target),{recursive:true});
 if(given){const bytes=readFileSync(given);if(sha(bytes)!==flac.archiveSha256)throw Error(`--flac-archive ${given} does not match the pinned SHA-256 ${flac.archiveSha256}`);if(given!==target)writeFileSync(target,bytes);return target;}
 if(existsSync(target)){if(sha(readFileSync(target))===flac.archiveSha256)return target;moveAside(target);}
 network(`libFLAC archive from ${lock.flac.url}`,'--flac-archive <flac-1.5.0.tar.xz>');
 const response=await fetch(lock.flac.url,{redirect:'follow'});if(!response.ok)throw Error(`Download failed: HTTP ${response.status} for ${lock.flac.url}`);
 const bytes=Buffer.from(await response.arrayBuffer());if(sha(bytes)!==flac.archiveSha256)throw Error(`Downloaded archive SHA-256 ${sha(bytes)} differs from the pin ${flac.archiveSha256}`);
 writeFileSync(target+'.partial',bytes);renameSync(target+'.partial',target);return target;
}
async function buildFlac(){
 const emsdk=ensureEmsdk(),archive=await ensureFlacArchive(),source=resolve(root,lock.flac.source),out=dirname(flacWasm);
 rmSync(source,{recursive:true,force:true});run('flac','tar',['-xJf',archive,'-C',dirname(source)]);clearOutput(out);
 run('flac','python3',['tools/codecs/flac/build.py','--source',source,'--archive',archive,'--emsdk',emsdk,'--out',relative(root,out)]);
}

// FLAC investigation evidence: vendored byte-identical generators run against the verified reference and codec.
const investigation=lock.flacInvestigation,outputs=['native-cases.json','native-error-cases.json','malformed-prototype-result.json'];
const normalizeErrors=value=>{const copy=structuredClone(value);for(const row of copy.rows)row.stderr=row.stderr.replace(/ @ 0x[0-9a-f]+\]/g,' @ 0x]');return sha(JSON.stringify(copy));};
const normalizePrototype=value=>{const copy={...value};delete copy.oracleSha256;return sha(JSON.stringify(copy));};
function verifyInvestigation(dir=resolve(root,'.build/flac-investigation')){
 const missing=outputs.filter(name=>!existsSync(join(dir,name)));if(missing.length)return fail('missing','missing '+missing.map(name=>'.build/flac-investigation/'+name).join(', '));
 if(!existsSync(resolve(referenceDir,'ffmpeg')))return fail('blocked','the reference is not built');
 const [cases,errors,prototype]=outputs.map(name=>readFileSync(join(dir,name))),[c,e,p]=outputs.map(name=>json(join(dir,name))),ffmpeg=sha(readFileSync(resolve(referenceDir,'ffmpeg'))),files=investigation.files;
 const links=[[c.generatorSha256===files['generate-native-cases.mjs'],'native-cases generator'],[c.reference?.artifacts?.ffmpeg===ffmpeg,'native-cases reference'],[e.sourceSha256===sha(cases),'error cases source'],[e.generatorSha256===files['generate-error-cases.mjs'],'error cases generator'],[e.reference?.artifacts?.ffmpeg===ffmpeg,'error cases reference'],[p.oracleSha256===sha(errors),'prototype oracle'],[p.wasmSha256===flac.wasmSha256,'prototype Wasm'],[p.adapterSha256===files['prototype/adapter.mjs'],'prototype adapter']];
 const broken=links.filter(([valid])=>!valid).map(([,name])=>name);if(broken.length)return fail('mismatch','provenance differs: '+broken.join(', '));
 const pin=Object.hasOwn(investigation.outputs,ffmpeg)?investigation.outputs[ffmpeg]:null;
 if(!pin){
  if(pinnedFfmpegHashes().has(ffmpeg))return fail('unpinned',`no content pin in tools/bootstrap/lock.json flacInvestigation.outputs for the pinned reference ffmpeg ${ffmpeg.slice(0,12)}`);
  return ok('generated against an unpinned reference; provenance links verified',{warning:'FLAC investigation outputs are not content-pinned for this reference'});
 }
 if(sha(cases)!==pin['native-cases.json'].sha256)return fail('mismatch','native-cases.json differs from the pinned '+pin['native-cases.json'].sha256.slice(0,12));
 if(normalizeErrors(e)!==pin['native-error-cases.json'].normalizedSha256)return fail('mismatch','native-error-cases.json differs beyond Native heap addresses');
 if(normalizePrototype(p)!==pin['malformed-prototype-result.json'].normalizedSha256)return fail('mismatch','malformed-prototype-result.json differs beyond its oracle hash');
 return ok(`native-cases ${sha(cases).slice(0,12)}; error cases and prototype baseline match their pins and link by hash`);
}
function buildInvestigation(){
 const stage=resolve(work,`work/flac-investigation-${process.pid}`),generated=resolve(stage,'.build/flac-investigation'),target=resolve(root,'.build/flac-investigation');
 rmSync(stage,{recursive:true,force:true});mkdirSync(resolve(generated,'prototype'),{recursive:true});symlinkSync(referenceDir,resolve(stage,'.build/reference'),'dir');
 for(const [name,digest]of Object.entries(investigation.files)){const bytes=readFileSync(resolve(here,'flac-investigation',name));if(sha(bytes)!==digest)throw Error('Vendored generator changed: '+name);writeFileSync(resolve(generated,name),bytes);}
 copyFileSync(flacWasm,resolve(generated,'prototype/edge-flac.wasm'));
 for(const script of ['generate-native-cases.mjs','generate-error-cases.mjs','verify-malformed-prototype.mjs'])run('flac-investigation',process.execPath,['.build/flac-investigation/'+script],stage);
 const state=inspect({verify:()=>verifyInvestigation(generated)});if(!state.ok)throw Error('Regenerated FLAC investigation evidence failed verification: '+state.detail);
 mkdirSync(target,{recursive:true});for(const name of outputs){if(existsSync(join(target,name)))moveAside(join(target,name));renameSync(join(generated,name),join(target,name));}
 rmSync(stage,{recursive:true,force:true});try{rmdirSync(dirname(stage));}catch{/* another stage is still present */}
}

const line=(id,state,note='')=>console.log(`${state.status.padEnd(12)} ${id.padEnd(19)} ${state.detail}${note}${state.warning?`\n${' '.repeat(33)}warning: ${state.warning}`:''}`);
const staleNote=()=>{const bytes=staleBytes();return bytes?`${show(staleDir)} holds ${(bytes/1048576).toFixed(1)} MB moved aside by earlier runs; delete it when no longer needed`:null;};

if(options.check){
 const major=Number(process.versions.node.split('.')[0]);console.log(`host ${host}, node ${process.versions.node}${major<24?' (Node.js 24+ required)':''}`);
 for(const command of ['git','npm','cc','make','bash','python3','cmake','tar']){const version=tool(command);console.log(`${(version?'found':'missing').padEnd(12)} ${command.padEnd(19)} ${version??'not on PATH'}`);}
 const emsdk=inspect({verify:()=>emsdkState(options.emsdk?userPath(options.emsdk):resolve(root,lock.emsdk.directory))});line('emsdk',emsdk.ok?emsdk:{...emsdk,detail:emsdk.detail+' (needed only to build codecs)'});
 const results=definitions.map(step=>{const state=inspect(step);line(step.id,state);return state;});
 const missing=steps.filter((id,index)=>!results[index].ok),note=staleNote();if(note)console.log(`${'stale'.padEnd(12)} ${'bootstrap'.padEnd(19)} ${note}`);
 console.log(missing.length?`not ready: ${missing.join(', ')}; run npm run bootstrap`:'ready: every bootstrap artifact is present and verified');process.exit(missing.length?1:0);
}

mkdirSync(work,{recursive:true});const runLock=resolve(work,'run.lock');
try{mkdirSync(runLock);}catch{
 const pid=Number(readFileSync(resolve(runLock,'pid'),{encoding:'utf8',flag:'a+'}));let alive=false;try{process.kill(pid,0);alive=pid>0;}catch{alive=false;}
 if(alive){console.error(`[bootstrap] another bootstrap (pid ${pid}) is running in this checkout`);process.exit(1);}rmSync(runLock,{recursive:true,force:true});mkdirSync(runLock);
}
writeFileSync(resolve(runLock,'pid'),String(process.pid));
const started=Date.now(),record={startedAt:new Date(started).toISOString(),host,node:process.versions.node,options:{...options,only:options.only&&[...options.only]},steps:[]},results={};let failure=null;
try{
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js 24+ is required');
 for(const step of definitions){
  const {id,build,needs}=step,begin=Date.now(),selected=!options.only||options.only.has(id);let state=inspect(step),action='verified';
  if(!state.ok&&selected){
   const blocked=needs.filter(dependency=>!results[dependency]?.ok);if(blocked.length)throw Error(`${id} needs ${blocked.join(', ')} first`);
   requireTools(step);rmSync(resolve(logs,id+'.log'),{force:true});log(`${id}: ${state.status} (${state.detail}); building`);
   try{await build(state);}catch(error){throw Error(`${id}: ${error.message}`);}
   state=inspect(step);action='built';if(!state.ok)throw Error(`${id} still ${state.status} after building: ${state.detail}`);
  }else if(!selected)action='not selected';
  results[id]=state;const seconds=(Date.now()-begin)/1000;record.steps.push({id,action,status:state.status,seconds,detail:state.detail,...(state.warning?{warning:state.warning}:{})});
  line(id,state,` [${action}, ${seconds.toFixed(1)}s]`);
 }
}catch(error){failure=error;}
finally{
 record.totalSeconds=(Date.now()-started)/1000;record.result=failure?'failed':'passed';if(failure)record.error=failure.message;
 writeFileSync(resolve(work,'last-run.json'),JSON.stringify(record,null,2)+'\n');rmSync(runLock,{recursive:true,force:true});
}
if(failure){console.error('[bootstrap] failed: '+failure.message);process.exit(1);}
const unselected=steps.filter(id=>!results[id].ok),note=staleNote();if(note)log(note);
log(`${unselected.length?'selected steps ready; not selected and not ready: '+unselected.join(', '):'ready'} in ${record.totalSeconds.toFixed(1)}s; record: .build/bootstrap/last-run.json`);
