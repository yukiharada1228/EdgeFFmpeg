import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {createHash} from 'node:crypto';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Expected recorded Darwin arm64 reference host');
if(execFileSync('git',['-C','upstream/ffmpeg','status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw new Error('Pinned upstream source has local changes');
const root='compat/behavior-specs/timed-frame-sync',hash=bytes=>createHash('sha256').update(bytes).digest('hex'),linux=JSON.parse(readFileSync(root+'/linux-provenance.json')),candidates=[];
mkdirSync('.build/timed-frame-sync-regenerate',{recursive:true});
for(const kind of ['two','three','many','boundary']){
 const name='timed-frame-sync-'+(kind==='boundary'?'two':kind);execFileSync(process.execPath,['tools/differential-runner/build-oracle.mjs',name],{stdio:'inherit',timeout:30000});
 const bytes=readFileSync(`${root}/${kind}-cases.json`),cases=JSON.parse(bytes),results=cases.map(c=>{const args=kind==='two'||kind==='boundary'?[c.shortest?'1':'0',c.ab??'1/25',c.bb??'1/25',c.a.join(','),c.b.join(','),c.endA,c.endB,...c.statuses.map(String)]:[...(kind==='many'?[String(c.bases.length)]:[]),c.shortest?'1':'0',...c.bases,...c.points.map(points=>points.join(',')),...c.ends,...c.statuses.map(String)];return JSON.parse(execFileSync(`.build/oracles/${name}/native`,args,{encoding:'utf8',timeout:5000}));}),serialized=JSON.stringify(results);
 writeFileSync(`.build/timed-frame-sync-regenerate/${kind}-results.json`,serialized);
 if(hash(serialized)!==linux.results[kind].resultsSha256)throw new Error('Recorded Linux profile differs; preserve candidate and review before replacing shared rows');
 candidates.push({kind,serialized,casesHash:hash(bytes),provenance:{cases:cases.length,oracle:JSON.parse(readFileSync(`.build/oracles/${name}/provenance.json`)),casesSha256:hash(bytes),resultsSha256:hash(serialized)}});
}
for(const candidate of candidates)if(hash(readFileSync(`${root}/${candidate.kind}-cases.json`))!==candidate.casesHash)throw new Error('Corpus changed during generation');
for(const {kind,serialized,provenance}of candidates){writeFileSync(`${root}/${kind}-results.json`,serialized);writeFileSync(`${root}/${kind}-host-provenance.json`,JSON.stringify(provenance,null,2));}
const manifest=JSON.parse(readFileSync(root+'/manifest.json'));for(const file of Object.keys(manifest.sha256))manifest.sha256[file]=hash(readFileSync(file));writeFileSync(root+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');
