import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { digest, verifyProfile, adaptCommand } from './profile.mjs';
import { snapshotReference, snapshotSource } from '../compatibility-report/source.mjs';
const root=resolve(import.meta.dirname,'../..'), upstream=resolve(root,'upstream/ffmpeg'), native=resolve(root,'.build/reference');
const directory=resolve(root,'.build/fate-execution',randomUUID());mkdirSync(directory,{recursive:true});
const report={schemaVersion:1,status:'failed',startedAt:new Date().toISOString(),directory:relative(root,directory),cases:[]};
const profilePaths=JSON.parse(readFileSync(resolve(root,'compat/fate/profiles.json'),'utf8'));
const run=(file,args,cwd)=>{
  const result=spawnSync(file,args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  if(result.error || result.status!==0) { const error=new Error(`FATE command failed: ${file} (exit ${result.status}): ${result.error??''}`);error.stdout=result.stdout;error.stderr=result.stderr;throw error; }
  return String(result.stdout??'')+String(result.stderr??'');
};
try {
  const before=snapshotSource(root), referenceBefore=snapshotReference(root);
  const lock=JSON.parse(readFileSync(resolve(root,'compat/upstream.lock.json'),'utf8'));
  if (before.upstreamCommit!==lock.commit || before.upstreamChanges) throw new Error('Modified or mismatched upstream');
  const metadata=JSON.parse(readFileSync(resolve(native,'build-metadata.json'),'utf8'));
  if (metadata.commit!==lock.commit || metadata.artifacts.ffmpeg!==referenceBefore.ffmpeg || metadata.artifacts.ffprobe!==referenceBefore.ffprobe) throw new Error('Invalid reference artifacts');
  if (JSON.stringify(metadata.flags)!==JSON.stringify(readFileSync(resolve(root,lock.configureFile),'utf8').trim().split(/\s+/))) throw new Error('Reference configure flags mismatch');
  const bundled=await build({stdin:{contents:`
    import { FFmpeg } from '@edge-ffmpeg/core';
    import { createMediaBackend } from '@edge-ffmpeg/avformat';
    import { createNodeFileSystem } from '@edge-ffmpeg/runtime-node';
    export async function execute(root,argv) {
      const filesystem=await createNodeFileSystem({root,maxReadBytes:65536,maxWriteBytes:65536});
      return new FFmpeg({filesystem,backend:createMediaBackend()}).exec(argv);
    }`,resolveDir:root},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
  const launcher=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  if (!Array.isArray(profilePaths) || !profilePaths.length || new Set(profilePaths).size!==profilePaths.length) throw new Error('Invalid reviewed FATE profiles');
  const seenIds=new Set();
  for (const path of profilePaths) {
    const profile=JSON.parse(readFileSync(resolve(root,path),'utf8'));
    if (seenIds.has(profile.id)) throw new Error('Duplicate reviewed FATE definition');
    seenIds.add(profile.id);
    const entry=verifyProfile(profile,file=>readFileSync(resolve(upstream,file)));
    const edgeArgv=adaptCommand(profile,entry.command);
    const caseDirectory=resolve(directory,profile.id);mkdirSync(caseDirectory,{recursive:true});
    const generatorLog=run('make',[profile.generatorTarget],native);
    const input=readFileSync(resolve(native,profile.generatorTarget));
    if (input.length!==profile.input.bytes || digest(input)!==profile.input.sha256) throw new Error('FATE input does not match pinned generator result');
    copyFileSync(resolve(native,profile.generatorTarget),resolve(caseDirectory,'input.sw'));
    const nativeArgs=[profile.id,'KEEP=1','GEN=no','CPUFLAGS=all','THREADS=1','HWACCEL=none','V=1'];
    const nativeLog=run('make',nativeArgs,native);writeFileSync(resolve(caseDirectory,'native.log'),generatorLog+nativeLog);
    const name=profile.id.slice(5), nativeBase=resolve(native,'tests/data/fate',name);
    if (readFileSync(`${nativeBase}.rep`,'utf8').trim()!==`${name}:0::`) throw new Error('Original native FATE target failed verification');
    const reference=readFileSync(resolve(upstream,profile.referenceFile));
    const nativeBytes=readFileSync(profile.comparison==='framecrc'?nativeBase:`${nativeBase}.out`);
    if (profile.comparison==='framecrc') {
      if(!nativeBytes.equals(reference)) throw new Error('Native framecrc differs from upstream reference');
    } else if (readFileSync(nativeBase,'utf8').trim()!==profile.md5 || digest(nativeBytes,'md5')!==profile.md5) throw new Error('Original native FATE MD5 failed verification');
    writeFileSync(resolve(caseDirectory,'native-output'),nativeBytes);copyFileSync(`${nativeBase}.rep`,resolve(caseDirectory,'native.rep'));
    writeFileSync(resolve(caseDirectory,'expected'),reference);
    const result=await launcher.execute(caseDirectory,edgeArgv);
    writeFileSync(resolve(caseDirectory,'edge-result.json'),JSON.stringify(result,null,2)+'\n');
    if (result.exitCode!==0 || result.outputs.length!==1 || result.outputs[0]!=='/output.sw') throw new Error(`Edge FATE execution failed: ${JSON.stringify(result.diagnostics)}`);
    const actual=readFileSync(resolve(caseDirectory,'output.sw'));
    if (!actual.equals(nativeBytes) || (profile.comparison!=='framecrc' && digest(actual,'md5')!==profile.md5)) throw new Error('Edge output differs from native FATE output or upstream expected result');
    report.cases.push({id:profile.id,status:'passed',comparison:profile.comparison??'md5',profileSha256:digest(readFileSync(resolve(root,path))),input:profile.input,output:{bytes:actual.length,sha256:digest(actual),md5:digest(actual,'md5')},nativeCommand:['make',...nativeArgs],edgeArgv,sources:profile.sources,adaptations:profile.adaptations,scope:profile.scope});
  }
  const after=snapshotSource(root), referenceAfter=snapshotReference(root);
  if (before.sha256!==after.sha256 || JSON.stringify(referenceBefore)!==JSON.stringify(referenceAfter)) throw new Error('Source or reference changed during FATE execution');
  report.status='passed';report.sourceSha256=before.sha256;report.referenceArtifacts=referenceBefore;
} catch(error) {
  report.failure=String(error);process.exitCode=1;
  if (error.stdout || error.stderr) writeFileSync(resolve(directory,'failure.log'),String(error.stdout??'')+String(error.stderr??''));
}
report.finishedAt=new Date().toISOString();
const text=JSON.stringify(report,null,2)+'\n';writeFileSync(resolve(directory,'report.json'),text);
mkdirSync(resolve(root,'compat/reports'),{recursive:true});writeFileSync(resolve(root,'compat/reports/fate-execution.json'),text);
console.log(`FATE execution ${report.status}: ${relative(root,directory)}/report.json`);
if(report.failure)console.error(report.failure);
