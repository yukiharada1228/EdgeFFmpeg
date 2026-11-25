// Cache key and build pins of the CI reference job (docs/contributing/ci.md).
//   node tools/ci/reference-cache.mjs pins          step outputs: key and every pin the build steps use
//   node tools/ci/reference-cache.mjs find <key>    step output run-id: a run of this repository that uploaded the
//                                                   reference-build-<key> artifact (needs GH_TOKEN with actions: read)
// The key hashes every pinned input of the native reference and the two Wasm codecs: the upstream lock, configure
// flags, container lock, reference pins, the upstream gitlink, .gitmodules and every tracked file of the build and
// bootstrap tools (the OpenH264, emsdk and libFLAC pins live in tools/codecs). The build steps take their pins from the
// outputs below, so the key covers what they build. Whatever a cache or another run's artifact restores is only
// trusted after `bootstrap --check` has matched it to compat/reference-pins.json and the codec locks.
import {execFileSync} from 'node:child_process';
import {appendFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'../..'),sha256=value=>createHash('sha256').update(value).digest('hex');
const json=path=>JSON.parse(readFileSync(resolve(root,path),'utf8'));
export const KEY_VERSION='v1';// bump when the reference job's build steps change
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
/** The newest unexpired reference-build-<key> artifact uploaded by a run of this repository (not a fork). */
export async function findArtifact(key,env=process.env){
 if(!/^reference-v\d+-[\w-]+$/.test(key))throw new Error(`Invalid key ${key}`);
 const url=`${env.GITHUB_API_URL??'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/actions/artifacts?name=reference-build-${key}&per_page=30`;
 const response=await fetch(url,{headers:{accept:'application/vnd.github+json',authorization:`Bearer ${env.GH_TOKEN}`,'x-github-api-version':'2022-11-28'}});
 if(!response.ok)throw new Error(`${url}: HTTP ${response.status}`);
 const repository=Number(env.GITHUB_REPOSITORY_ID),candidates=(await response.json()).artifacts.filter(artifact=>!artifact.expired&&artifact.workflow_run?.repository_id===repository&&artifact.workflow_run?.head_repository_id===repository);
 candidates.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 return candidates[0]?{runId:String(candidates[0].workflow_run.id),branch:candidates[0].workflow_run.head_branch,artifactId:candidates[0].id}:null;
}

if(import.meta.url===`file://${process.argv[1]}`){
 const [command,key]=process.argv.slice(2),output=lines=>{console.log(lines.join('\n'));if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,lines.join('\n')+'\n');};
 if(command==='pins'){const {key:value,files}=cacheKey();console.log(`cache key inputs: ${files.length} files`);output([`key=${value}`,...Object.entries(buildPins()).map(([name,pin])=>`${name}=${pin}`)]);}
 else if(command==='find'&&key){let found=null;try{found=await findArtifact(key);}catch(error){console.log(`No shared reference artifact: ${error.message}`);}
  if(found)console.log(`reference-build-${key} from run ${found.runId} on ${found.branch}`);output([`run-id=${found?.runId??''}`]);}
 else{console.error('Usage: node tools/ci/reference-cache.mjs pins | find <key>');process.exitCode=2;}
}
