import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const here=import.meta.dirname,root=resolve(here,'../../..'),lock=JSON.parse(readFileSync(resolve(here,'build.lock.json'))),args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--source','--emsdk','--out','--cache'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('Usage: node tools/codecs/openh264/build.mjs --source <clean pinned git checkout> --emsdk <pinned emsdk checkout> [--out <new directory>] [--cache <dedicated Emscripten cache>]');options[args[i]]=args[i+1];}
if(!options['--source']||!options['--emsdk'])throw Error('--source and --emsdk are required; no implicit network download');
const source=resolve(options['--source']),emsdk=resolve(options['--emsdk']),output=resolve(options['--out']??resolve(root,'.build/codecs/openh264')),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),run=(file,args,cwd,capture=true,input)=>execFileSync(file,args,{cwd,encoding:'utf8',stdio:capture?'pipe':'inherit',...(input===undefined?{}:{input}),maxBuffer:16777216});
if(run('git',['rev-parse','HEAD'],source).trim()!==lock.sourceCommit||run('git',['status','--porcelain','--untracked-files=no'],source).trim())throw Error('Source must be the clean pinned OpenH264 commit');
if(run('git',['rev-parse','HEAD'],emsdk).trim()!==lock.emsdkCommit)throw Error('Emsdk commit mismatch');
for(const [name,digest]of [['source.patch',lock.patchSha256],['wrapper.cpp',lock.wrapperSha256]])if(hash(readFileSync(resolve(here,name)))!==digest)throw Error('Build input changed: '+name);
if(existsSync(output))throw Error('Output directory already exists; choose a fresh --out directory');mkdirSync(resolve(output,'..'),{recursive:true});mkdirSync(output);const work=resolve(output,'source');mkdirSync(work);
run('git',['init','--quiet'],work);run('git',['fetch','--quiet','--depth=1',source,lock.sourceCommit],work);run('git',['checkout','--quiet','--detach','FETCH_HEAD'],work);
run('git',['apply','--check',resolve(here,'source.patch')],work);run('git',['apply',resolve(here,'source.patch')],work);
if(hash(execFileSync('git',['diff','--binary'],{cwd:work}))!==lock.patchSha256)throw Error('Applied source patch differs');
run('bash',[resolve(here,'compile.sh'),work,emsdk,here,output,options['--cache']?resolve(options['--cache']):''],root,false);
const wasm=readFileSync(resolve(output,'openh264.wasm')),digest=hash(wasm);if(digest!==lock.expectedWasmSha256)throw Error('Compiled Wasm differs from pinned verified artifact: '+digest);
const map=readFileSync(resolve(output,'link.map'),'utf8'),archives=[...new Set(map.match(/\/[^\s]+\.a/g)??[])].sort();
writeFileSync(resolve(output,'build-metadata.json'),JSON.stringify({sourceCommit:lock.sourceCommit,patchSha256:lock.patchSha256,wrapperSha256:lock.wrapperSha256,compileRecipeSha256:hash(readFileSync(resolve(here,'compile.sh'))),emsdkCommit:lock.emsdkCommit,compiler:readFileSync(resolve(output,'compiler.txt'),'utf8'),wasmSha256:digest,wasmBytes:wasm.length,linkedArchives:Object.fromEntries(archives.map(path=>[path,hash(readFileSync(path))])),runtimeCache:options['--cache']?resolve(options['--cache']):null,sourceContainsTestMedia:true,redistributionAuditComplete:false},null,2)+'\n');
console.log(JSON.stringify({output,wasmSha256:digest,wasmBytes:wasm.length}));
