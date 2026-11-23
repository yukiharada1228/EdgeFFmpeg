import {mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const args=process.argv.slice(2);
const options={shards:'16',suite:'portable-unit-v1',output:`.build/modal/${new Date().toISOString().replace(/[:.]/g,'-')}`};
for(let i=0;i<args.length;i+=2){
  const name=args[i]?.replace(/^--/,'');
  if(!['shards','suite','output'].includes(name)||!args[i+1])throw Error('Usage: node tools/modal/launch.mjs [--shards 1..16] [--suite portable-unit-v1|flac-unit-v1] [--output NEW_DIRECTORY]');
  options[name]=args[i+1];
}
const shards=Number(options.shards);
if(!Number.isInteger(shards)||shards<1||shards>16)throw Error('shards must be 1..16');
const output=resolve(root,options.output);
if(existsSync(output))throw Error('Output directory already exists; use a new run directory');
mkdirSync(output,{recursive:true});
function run(command,argv,env=process.env){
 const result=spawnSync(command,argv,{cwd:root,env,stdio:'inherit'});
 if(result.error)throw result.error;
 return result.status??1;
}
const stage=resolve(output,'stage');
if(run(process.execPath,['tools/modal/manifest.mjs','--shards',String(shards),'--suite',options.suite,'--stage',stage,'--output',resolve(output,'manifest.json')])!==0)throw Error('Manifest preparation failed');
const dependencyStage=resolve(output,'dependencies');
const manifest=JSON.parse(readFileSync(resolve(output,'manifest.json'),'utf8'));
for(const file of manifest.source.files.filter(f=>f.path==='package.json'||f.path==='package-lock.json'||/^packages\/[^/]+\/package.json$/.test(f.path))){
 const target=resolve(dependencyStage,file.path);mkdirSync(dirname(target),{recursive:true});copyFileSync(resolve(stage,file.path),target);
}
const started=Date.now();
const exitCode=run('modal',['run',resolve(stage,'tools/modal/app.py')],{...process.env,EDGE_MODAL_STAGE:stage,EDGE_MODAL_OUTPUT:resolve(output,'results')});
const reportPath=resolve(output,'results/summary.json');
const summary=existsSync(reportPath)?JSON.parse(readFileSync(reportPath,'utf8')):null;
writeFileSync(resolve(output,'launch.json'),JSON.stringify({schemaVersion:1,startedAt:new Date(started).toISOString(),wallSeconds:(Date.now()-started)/1000,exitCode,sourceSha256:JSON.parse(readFileSync(resolve(output,'manifest.json'),'utf8')).source.sha256,resultStatus:summary?.status??'no-report'},null,2)+'\n');
console.log(`Modal validation ${summary?.status??'failed before report'}: ${output}`);
process.exitCode=exitCode|| (summary?.status==='passed'?0:1);
