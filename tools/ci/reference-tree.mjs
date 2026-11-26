// Whole-tree manifest of the cached reference build (docs/contributing/ci.md).
//   node tools/ci/reference-tree.mjs record [--manifest <file>]
//       hashes every file of the tree, writes the manifest (default .build/reference-tree.json) and prints the
//       step output sha256 (also to GITHUB_OUTPUT)
//   node tools/ci/reference-tree.mjs verify --sha256 <hash> [--manifest <file>]
//   node tools/ci/reference-tree.mjs verify --cache-key <key> --matched-key <restored key> [--manifest <file>]
//       recomputes the manifest of the restored tree and requires its hash to equal the recorded one: the hash the
//       building job put into the cache key or artifact name (<key>-tree-<sha256>), or the reference job's output.
//       On a mismatch it lists the files that differ from the restored manifest file, as a diagnosis only.
// The tree is what the cache and the reference artifacts hold: every file under .build/reference (hidden files and the
// configure link `src` to the FFmpeg sources included, followed the way upload-artifact follows it, because the build
// tree's Makefile reads its sources through ./src) and both Wasm codecs. Each entry is path, size and SHA-256 of the
// content. File modes and timestamps are not part of it: artifacts drop the executable bit and the report job gives
// the tree one timestamp. bootstrap --check still matches ffmpeg, ffprobe, the pinned libraries and the codecs to
// their pins; this check covers every other file the tests and the FATE gate use.
import {appendFileSync,existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'../..');
export const TREE_PATHS=Object.freeze(['.build/reference','.build/codecs/openh264/openh264.wasm','.build/codecs/flac/edge-flac.wasm']);
export const MANIFEST='.build/reference-tree.json';
const DIGEST=/^[0-9a-f]{64}$/;
const sha256=value=>createHash('sha256').update(value).digest('hex');
/** Manifest of the tree under directory: {schemaVersion, kind, paths, files, bytes, sha256, entries: [[path, size, sha256], ...]}. */
export function treeManifest(directory=root,paths=TREE_PATHS){
 const entries=[],missing=[],active=new Set();
 const walk=(relative,absolute)=>{
  let stat;try{stat=statSync(absolute);}catch{return;}// a broken link is left out, as upload-artifact leaves it out
  if(stat.isDirectory()){
   const real=realpathSync(absolute);if(active.has(real))throw new Error(`${relative} links back into itself`);
   active.add(real);for(const name of readdirSync(absolute).sort())walk(`${relative}/${name}`,`${absolute}/${name}`);active.delete(real);
  }else if(stat.isFile())entries.push([relative,stat.size,sha256(readFileSync(absolute))]);
 };
 for(const path of paths){if(!existsSync(resolve(directory,path)))missing.push(path);walk(path,resolve(directory,path));}
 entries.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
 const canonical=entries.map(([path,size,digest])=>`${digest} ${size} ${path}\n`).join('');
 return {schemaVersion:1,kind:'edgeffmpeg-reference-tree',paths:[...paths],missing,files:entries.length,bytes:entries.reduce((sum,entry)=>sum+entry[1],0),sha256:sha256(canonical),entries};
}
/** The hash a restored key records: <cacheKey>-tree-<sha256>. */
export function recordedHash(cacheKey,matchedKey){
 const prefix=`${cacheKey}-tree-`;
 if(typeof matchedKey!=='string'||!matchedKey.startsWith(prefix)||!DIGEST.test(matchedKey.slice(prefix.length)))throw new Error(`${JSON.stringify(matchedKey)} is not ${prefix}<sha256>`);
 return matchedKey.slice(prefix.length);
}
/** Paths whose entries differ between two manifests. */
export function differences(expected,actual){
 const a=new Map((expected?.entries??[]).map(([path,size,digest])=>[path,`${size} ${digest}`])),b=new Map(actual.entries.map(([path,size,digest])=>[path,`${size} ${digest}`]));
 const result=[];
 for(const [path,value]of a)if(!b.has(path))result.push(`missing ${path}`);else if(b.get(path)!==value)result.push(`changed ${path}`);
 for(const path of b.keys())if(!a.has(path))result.push(`added ${path}`);
 return result;
}
export function verifyTree(expectedSha256,{directory=root,manifest=resolve(directory,MANIFEST)}={}){
 if(!DIGEST.test(String(expectedSha256)))throw new Error(`Invalid recorded tree hash ${JSON.stringify(expectedSha256)}`);
 const actual=treeManifest(directory);
 if(actual.sha256===expectedSha256&&!actual.missing.length)return {ok:true,actual,problems:[]};
 const problems=[...actual.missing.map(path=>`${path} is missing`),`the tree hashes to ${actual.sha256}, not the recorded ${expectedSha256}`];
 let recorded=null;try{recorded=JSON.parse(readFileSync(manifest,'utf8'));}catch{recorded=null;}
 if(recorded?.sha256===expectedSha256)problems.push(...differences(recorded,actual).slice(0,50));
 else problems.push(`no manifest with the recorded hash at ${manifest} to list the differing files`);
 return {ok:false,actual,problems};
}

if(import.meta.url===`file://${process.argv[1]}`){
 const [command,...args]=process.argv.slice(2),option=name=>{const at=args.indexOf(name);return at<0?null:args[at+1]??null;};
 const manifest=resolve(process.env.INIT_CWD??process.cwd(),option('--manifest')??resolve(root,MANIFEST));
 const output=line=>{console.log(line);if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,line+'\n');};
 if(command==='record'){
  const tree=treeManifest();
  if(tree.missing.length){console.error(`Cannot record the reference tree: ${tree.missing.join(', ')} missing`);process.exit(1);}
  mkdirSync(dirname(manifest),{recursive:true});writeFileSync(manifest,JSON.stringify(tree)+'\n');
  console.log(`reference tree: ${tree.files} files, ${tree.bytes} bytes; manifest ${manifest}`);output(`sha256=${tree.sha256}`);
 }else if(command==='verify'){
  let expected=option('--sha256');
  try{if(!expected)expected=recordedHash(option('--cache-key'),option('--matched-key'));}catch(error){console.error(String(error.message));process.exit(2);}
  const result=verifyTree(expected,{manifest});
  if(result.ok){console.log(`reference tree verified: ${result.actual.files} files, ${result.actual.bytes} bytes, sha256 ${result.actual.sha256}`);output(`sha256=${result.actual.sha256}`);}
  else{for(const problem of result.problems)console.error(`FAIL ${problem}`);console.error('The restored reference tree is not the recorded one');process.exitCode=1;}
 }else{console.error('Usage: node tools/ci/reference-tree.mjs record [--manifest <file>] | verify (--sha256 <hash> | --cache-key <key> --matched-key <key>) [--manifest <file>]');process.exitCode=2;}
}
