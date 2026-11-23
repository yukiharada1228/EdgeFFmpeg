import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const read=p=>fs.readFileSync(p),hash=b=>createHash('sha256').update(b).digest('hex');
const singleRoot='compat/behavior-specs/output-open/',graphRoot='compat/behavior-specs/multi-output-policy/';
const profiles=JSON.parse(read(singleRoot+'profiles.json')),graphs=JSON.parse(read(graphRoot+'profiles.json')),graphInputs=JSON.parse(read(graphRoot+'inputs.json'));
const reference=JSON.parse(read('.build/reference/build-metadata.json')),lock=JSON.parse(read('compat/upstream.lock.json'));
const generator='tools/differential-runner/node-input-directory/generate.mjs',out='compat/behavior-specs/node-input-directory/';
const sources=[generator,...[singleRoot,graphRoot].flatMap(root=>[root+'manifest.json',...Object.keys(JSON.parse(read(root+'manifest.json')).sha256).map(n=>root+n)])];
const sourceHashes=Object.fromEntries(sources.map(p=>[p,hash(read(p))]));
function verify(){
 if(reference.commit!==lock.commit)throw Error('Reference commit changed');
 for(const n of ['ffmpeg','ffprobe'])if(hash(read('.build/reference/'+n))!==reference.artifacts[n])throw Error('Reference binary changed');
 for(const root of [singleRoot,graphRoot])for(const[n,digest]of Object.entries(JSON.parse(read(root+'manifest.json')).sha256))if(hash(read(root+n))!==digest)throw Error('Source fixture changed: '+n);
 for(const p of [...profiles,...graphInputs])if(hash(Buffer.from(p.input,'base64'))!==p.sha256)throw Error('Input fixture changed');
 for(const[p,digest]of Object.entries(sourceHashes))if(hash(read(p))!==digest)throw Error('Generator/source changed');
}
verify();const root=fs.mkdtempSync(join(tmpdir(),'native-input-directory-')),sentinel=Buffer.from([17,31,43]),results=[];
function run(group,details,argv,directoryPaths,regularInputs,outputPaths,mask,populated=false){
 const id=group+'-'+results.length,folder=join(root,id);fs.mkdirSync(folder);
 for(const path of directoryPaths){fs.mkdirSync(join(folder,path.slice(1)));if(populated)fs.writeFileSync(join(folder,path.slice(1),'member'),sentinel);}
 for(const input of regularInputs)if(!directoryPaths.includes(input.path))fs.writeFileSync(join(folder,input.path.slice(1)),Buffer.from(input.input,'base64'));
 for(const[index,path]of outputPaths.entries())if(mask&(1<<index))fs.writeFileSync(join(folder,path.slice(1)),sentinel);
 const paths=new Set([...directoryPaths,...regularInputs.map(p=>p.path),...outputPaths]);
 const native=spawnSync('.build/reference/ffmpeg',['-v','error',...argv.map(a=>paths.has(a)?join(folder,a.slice(1)):a)],{input:'',encoding:'utf8',timeout:15000});
 if(native.error||native.signal||native.status===null)throw Error(id+': '+String(native.error??native.signal));
 const outputs=outputPaths.map(path=>{const p=join(folder,path.slice(1));if(!fs.existsSync(p))return null;const bytes=read(p);return {bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')};});
 for(const path of directoryPaths){const names=fs.readdirSync(join(folder,path.slice(1)));if(JSON.stringify(names)!==JSON.stringify(populated?['member']:[]))throw Error('Input directory mutated');if(populated&&!read(join(folder,path.slice(1),'member')).equals(sentinel))throw Error('Input member mutated');}
 results.push({id,group,...details,argv,directoryPaths,regularInputs,outputPaths,mask,populated,exitCode:native.status,outputs,stderr:native.stderr.replaceAll(folder,'<case>').replace(/0x[0-9a-f]+/g,'<address>')});
 fs.rmSync(folder,{recursive:true,force:true});
}
try{
 for(const[pindex,p]of profiles.entries())for(const bitexact of pindex<8?[false,true]:[false])for(const populated of [false,true])for(const mask of [0,1])for(const flags of [[],['-n'],['-y'],['-y','-n'],['-n','-y']])for(const xerror of [false,true]){
  run('single',{profile:p.id,bitexact,flags,xerror},[...(xerror?['-xerror']:[]),...flags,...p.inputOptions,'-i','/input',...(bitexact?['-fflags','+bitexact']:[]),...p.outputOptions,'/output'],['/input'],[],['/output'],mask,populated);
 }
 for(const p of graphs)for(const directory of p.argv.filter((_,i)=>p.argv[i-1]==='-i'))for(const flags of [[],['-n'],['-y'],['-y','-n'],['-n','-y']])for(const xerror of [false,true])for(let mask=0;mask<4;mask++){
  run('graph',{profile:p.id,flags,xerror},[...(xerror?['-xerror']:[]),...flags,...p.argv],[directory],graphInputs,['/output-0.bin','/output-1.bin'],mask);
 }
 for(const p of profiles.slice(0,8))for(const errorFlags of [[],['-xerror'],['-noxerror'],['-xerror','-noxerror'],['-noxerror','-xerror']])for(const mode of ['normal','zero-frames','zero-duration','input-seek','output-seek']){
  const before=mode==='input-seek'?['-ss','0.001']:[],after=mode==='zero-frames'?[p.id.includes('video')?'-frames:v':'-frames:a','0']:mode==='zero-duration'?['-t','0']:mode==='output-seek'?['-ss','0.001']:[];
  run('termination',{profile:p.id,errorFlags,mode},['-y',...errorFlags,...p.inputOptions,...before,'-i','/input','-fflags','+bitexact',...p.outputOptions,...after,'/output'],['/input'],[],['/output'],0);
 }
 for(const directory of [0,1])for(const xerror of [false,true])for(const mode of ['automatic','mapped-good','mapped-bad']){
  const argv=['-y',...(xerror?['-xerror']:[])];for(let i=0;i<2;i++)argv.push('-f','rawvideo','-pixel_format','gray','-video_size','2x2','-framerate','25','-i','/input'+i);
  if(mode!=='automatic')argv.push('-map',String(mode==='mapped-good'?1-directory:directory)+':v');argv.push('-c:v','rawvideo','-bitexact','-f','rawvideo','/output');
  run('automatic',{directory,xerror,mode},argv,['/input'+directory],[0,1].map(i=>({path:'/input'+i,input:Buffer.from([1,2,3,4,5,6,7,8]).toString('base64')})),['/output'],0);
 }
 verify();const counts=Object.fromEntries(['single','graph','termination','automatic'].map(g=>[g,results.filter(r=>r.group===g).length])),histogram={};for(const r of results)histogram[r.exitCode]=(histogram[r.exitCode]??0)+1;
 if(JSON.stringify(counts)!==JSON.stringify({single:1360,graph:360,termination:200,automatic:12})||results.length!==1932)throw Error('Incomplete directory corpus');
 for(const[status,count]of [[0,548],[183,600],[234,520],[235,264]])if(histogram[status]!==count)throw Error('Unexpected Native directory outcomes');
 fs.mkdirSync(out,{recursive:true});for(const[n,value]of [['results.json',results],['provenance.json',{reference,sources:sourceHashes,caseCount:1932,counts,histogram,scope:'Native-only initial directory read/discovery,declared raw streams,selected-input policy;default metadata retained alongside bitexact raw cases. No midstream or full-conformance certification.'}]])fs.writeFileSync(out+n,JSON.stringify(value,null,2)+'\n');
 fs.writeFileSync(out+'manifest.json',JSON.stringify({sha256:Object.fromEntries(['results.json','provenance.json'].map(n=>[n,hash(read(out+n))]))},null,2)+'\n');console.log(JSON.stringify({cases:results.length,counts,histogram}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
