// Cache key and build pins of the CI reference job (docs/contributing/ci.md).
//   node tools/ci/reference-cache.mjs pins          step outputs: key and every pin the build steps use
//   node tools/ci/reference-cache.mjs find <key>    step outputs run-id and tree-sha256: the newest run of this
//                                                   repository that uploaded a reference-build-<key>-tree-<sha256>
//                                                   artifact (needs GH_TOKEN with actions: read)
// The key hashes every pinned input of the native reference and the two Wasm codecs: the upstream lock, configure
// flags, container lock, reference pins, the upstream gitlink, .gitmodules and every tracked file of the build and
// bootstrap tools (the OpenH264, emsdk and libFLAC pins live in tools/codecs). The build steps take their pins from the
// outputs below, so the key covers what they build. The job that builds the tree records its whole-tree manifest
// (tools/ci/reference-tree.mjs) and saves the cache as <key>-tree-<manifest sha256> and the artifact as
// reference-build-<key>-tree-<manifest sha256>. Whatever a cache or another run's artifact restores is only trusted
// after reference-tree.mjs has matched every file to the hash in that name and `bootstrap --check` has matched the
// programs, libraries and codecs to compat/reference-pins.json and the codec locks.
import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'../..'),sha256=value=>createHash('sha256').update(value).digest('hex');
const json=path=>JSON.parse(readFileSync(resolve(root,path),'utf8'));
export const KEY_VERSION='v2';// bump when the reference job's build steps or the cached content change (v2: the tree manifest)
export const KEY_INPUTS=Object.freeze(['.gitmodules','compat/upstream.lock.json','compat/configure.flags','compat/reference-container.lock.json','compat/reference-pins.json','tools/upstream-build','tools/codecs','tools/bootstrap','tools/ci/reference-cache.mjs']);
export function cacheKey(){
 const files=execFileSync('git',['ls-files','-z','--',...KEY_INPUTS],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).sort();
 const gitlink=execFileSync('git',['ls-tree','HEAD','upstream/ffmpeg'],{cwd:root,encoding:'utf8'}).trim();
 const manifest=[`version ${KEY_VERSION}`,`host ${process.platform}-${process.arch}`,`gitlink ${gitlink}`,...files.map(file=>`${file} ${sha256(readFileSync(resolve(root,file)))}`)].join('\n');
 return {key:`reference-${KEY_VERSION}-${process.platform}-${process.arch}-${sha256(manifest)}`,files};
}
export function buildPins(){
 const h264=json('tools/codecs/openh264/build.lock.json'),flac=json('tools/codecs/flac/inputs.json'),bootstrap=json('tools/bootstrap/lock.json'),container=json('compat/reference-container.lock.json');
 if(h264.emsdkCommit!==flac.emsdkCommit||h264.emscriptenVersion!==flac.emsdkVersion)throw new Error('The OpenH264 and libFLAC locks disagree on emsdk');
 const image=process.env.EDGEFFMPEG_CONTAINER_IMAGE;
 if(image!==undefined&&image!==container.image)throw new Error(`EDGEFFMPEG_CONTAINER_IMAGE ${image} is not the locked image ${container.image}`);
 const pins={'openh264-commit':h264.sourceCommit,'emsdk-commit':h264.emsdkCommit,'emsdk-version':h264.emscriptenVersion,'flac-url':bootstrap.flac.url,'flac-sha256':flac.archiveSha256,'flac-archive':bootstrap.flac.archive,'flac-source':bootstrap.flac.source};
 for(const [name,value]of Object.entries(pins))if(typeof value!=='string'||!/^[\w.:/-]+$/.test(value))throw new Error(`Unexpected pin ${name}: ${value}`);
 return pins;
}
const TREE_NAME=/^[0-9a-f]{64}$/;
/**
 * The newest unexpired reference-build-<key>-tree-<sha256> artifact uploaded by a run of this repository (not a fork),
 * with the tree hash its name records. The API filters names only exactly, so the newest pages of the repository's
 * artifacts are searched; an older build is not found, and the reference job then builds.
 */
export async function findArtifact(key,env=process.env,{pages=10}={}){
 if(!/^reference-v\d+-[\w-]+$/.test(key))throw new Error(`Invalid key ${key}`);
 const prefix=`reference-build-${key}-tree-`,repository=Number(env.GITHUB_REPOSITORY_ID),candidates=[];
 for(let page=1;page<=pages;page++){
  const url=`${env.GITHUB_API_URL??'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/actions/artifacts?per_page=100&page=${page}`;
  const response=await fetch(url,{headers:{accept:'application/vnd.github+json',authorization:`Bearer ${env.GH_TOKEN}`,'x-github-api-version':'2022-11-28'}});
  if(!response.ok)throw new Error(`${url}: HTTP ${response.status}`);
  const artifacts=(await response.json()).artifacts??[];
  candidates.push(...artifacts.filter(artifact=>!artifact.expired&&artifact.name.startsWith(prefix)&&TREE_NAME.test(artifact.name.slice(prefix.length))&&artifact.workflow_run?.repository_id===repository&&artifact.workflow_run?.head_repository_id===repository));
  if(artifacts.length<100)break;
 }
 candidates.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 const found=candidates[0];
 return found?{runId:String(found.workflow_run.id),branch:found.workflow_run.head_branch,artifactId:found.id,name:found.name,treeSha256:found.name.slice(prefix.length)}:null;
}

if(import.meta.url===`file://${process.argv[1]}`){
 const [command,key]=process.argv.slice(2),output=lines=>{console.log(lines.join('\n'));if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,lines.join('\n')+'\n');};
 if(command==='pins'){const {key:value,files}=cacheKey();console.log(`cache key inputs: ${files.length} files`);output([`key=${value}`,...Object.entries(buildPins()).map(([name,pin])=>`${name}=${pin}`)]);}
 else if(command==='find'&&key){let found=null;try{found=await findArtifact(key);}catch(error){console.log(`No shared reference artifact: ${error.message}`);}
  if(found)console.log(`${found.name} from run ${found.runId} on ${found.branch}`);output([`run-id=${found?.runId??''}`,`artifact=${found?.name??''}`,`tree-sha256=${found?.treeSha256??''}`]);}
 else{console.error('Usage: node tools/ci/reference-cache.mjs pins | find <key>');process.exitCode=2;}
}
