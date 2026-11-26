// Checks that a run uploads every file a baseline run uploaded, artifact by artifact (docs/contributing/ci.md).
//   node tools/ci/compare-evidence.mjs <baseline dir> <candidate dir> [--artifacts <name> ...]
// Each dir holds a run's artifacts by name: <dir>/<name>/ as `gh run download -n <name> -D <dir>/<name>` extracts it,
// or <dir>/<name>.list, the `unzip -l` listing of the artifact's zip (for large artifacts). Paths are compared after
// replacing each run's own directory names (.build/evidence/<run>/, .build/fate-execution/<run>/) with <run>. The
// artifacts compared default to every artifact of the baseline. Exits 0 only when no baseline file is missing.
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve} from 'node:path';

const RUN_DIRECTORIES=[/^(\.build\/evidence\/)[^/]+\//,/^(\.build\/fate-execution\/)[^/]+\//];
export const normalize=path=>RUN_DIRECTORIES.reduce((value,pattern)=>value.replace(pattern,'$1<run>/'),path);
/** The normalized file paths of one artifact, from its extracted directory or its zip listing. */
export function artifactFiles(directory,name){
 const extracted=resolve(directory,name),listing=resolve(directory,`${name}.list`),files=new Set();
 if(existsSync(extracted)&&statSync(extracted).isDirectory()){
  const walk=relative=>{for(const entry of readdirSync(resolve(extracted,relative),{withFileTypes:true})){const path=relative?`${relative}/${entry.name}`:entry.name;if(entry.isDirectory())walk(path);else files.add(normalize(path));}};
  walk('');
 }else if(existsSync(listing)){
  // unzip -l: "  <length>  <date> <time>   <name>"; directories end with '/'.
  for(const line of readFileSync(listing,'utf8').split('\n')){const match=/^\s*\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);if(match&&!match[1].endsWith('/')&&!/^-+$/.test(match[1]))files.add(normalize(match[1]));}
 }else return null;
 return files;
}
export function artifactNames(directory){
 return [...new Set(readdirSync(directory,{withFileTypes:true}).map(entry=>entry.isDirectory()?entry.name:entry.name.endsWith('.list')?entry.name.slice(0,-5):null).filter(Boolean))].sort();
}
export function compareEvidence(baselineDirectory,candidateDirectory,{artifacts=artifactNames(baselineDirectory)}={}){
 const result={equivalent:true,artifacts:{}};
 for(const name of artifacts){
  const baseline=artifactFiles(baselineDirectory,name),candidate=artifactFiles(candidateDirectory,name);
  if(!baseline)throw new Error(`The baseline has no artifact ${name}`);
  const missing=candidate?[...baseline].filter(path=>!candidate.has(path)).sort():[...baseline].sort(),added=candidate?[...candidate].filter(path=>!baseline.has(path)).sort():[];
  if(missing.length)result.equivalent=false;
  result.artifacts[name]={present:candidate!==null,baselineFiles:baseline.size,candidateFiles:candidate?.size??0,missing,addedCount:added.length,added:added.slice(0,200)};
 }
 return result;
}

if(import.meta.url===`file://${process.argv[1]}`){
 const args=process.argv.slice(2),at=args.indexOf('--artifacts'),names=at>=0?args.splice(at).slice(1):null;
 if(args.length!==2){console.error('Usage: node tools/ci/compare-evidence.mjs <baseline dir> <candidate dir> [--artifacts <name> ...]');process.exit(2);}
 const cwd=process.env.INIT_CWD??process.cwd(),result=compareEvidence(resolve(cwd,args[0]),resolve(cwd,args[1]),names?{artifacts:names}:{});
 console.log(JSON.stringify(result,null,1));
 console.log(result.equivalent?'EVERY BASELINE FILE PRESENT':'BASELINE FILES MISSING');
 process.exitCode=result.equivalent?0:1;
}
