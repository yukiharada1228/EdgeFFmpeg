// Development-only Native corpus generation; never imported by runtime packages.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const mode=process.argv[2];
if(!['--check','--write'].includes(mode)||process.argv.length!==3)throw Error('Expected --check or --write');
const root=process.cwd(),directory=resolve(root,'compat/behavior-specs/bmp'),oracleDirectory=resolve(root,'.build/oracles/bmp-rle'),binary=resolve(oracleDirectory,'native');
const json=path=>JSON.parse(readFileSync(path,'utf8')),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),fileHash=path=>hash(readFileSync(path));
const provenance=json(resolve(directory,'provenance.json')),oracle=json(resolve(oracleDirectory,'provenance.json')),lock=json(resolve(root,'compat/upstream.lock.json'));
function verify(){
 if(provenance.commit!==lock.commit||oracle.reference.commit!==lock.commit||execFileSync('git',['-C',resolve(root,'upstream/ffmpeg'),'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==lock.commit)throw Error('BMP target commit mismatch');
 for(const [path,digest]of Object.entries({...provenance.sources,...provenance.recipes}))if(fileHash(resolve(root,path))!==digest)throw Error('BMP source or recipe changed: '+path);
 if(fileHash(resolve(root,'tools/differential-runner/bmp-rle/oracle.c'))!==oracle.sourceSha256||fileHash(binary)!==oracle.binarySha256)throw Error('BMP oracle changed');
 for(const [path,digest]of Object.entries(oracle.librarySha256))if(fileHash(path)!==digest)throw Error('Native library changed: '+path);
 for(const [name,digest]of Object.entries(provenance.reference))if(fileHash(resolve(root,'.build/reference',name))!==digest)throw Error('Native binary changed: '+name);
}
verify();
const bundle=await build({entryPoints:[resolve(root,'tests/helpers/bmp-fixture.ts')],bundle:true,write:false,platform:'node',format:'esm'}),{image}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const rows=[];
for(const alignment of [8,16,32,64])for(const depth of [4,8])for(const top of [false,true])for(const width of [3,17,33])for(let seed=1;seed<=32;seed++){
 let state=seed;const stream=[];for(let i=0;i<31;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;stream.push(state>>>24);}stream.push(0,1);
 const input=image(width,4,depth,top,stream),output=execFileSync(binary,[String(alignment)],{input,timeout:5000,maxBuffer:65536,stdio:['pipe','pipe','pipe']});
 if(output.length!==4+width*4+1024||output.readUInt32LE(0)!==Math.ceil(width/alignment)*alignment)throw Error('Unexpected Native frame layout');
 rows.push({alignment,depth,top,width,seed,stride:output.readUInt32LE(0),sha256:hash(output.subarray(4))});
}
verify();
const serialized=JSON.stringify(rows,null,2)+'\n',path=resolve(directory,'rle-profiles.json');
if(mode==='--check'){
 if(readFileSync(path,'utf8')!==serialized)throw Error('Cached BMP corpus differs from fresh Native results');
}else{
 writeFileSync(path,serialized);writeFileSync(resolve(directory,'oracle-provenance.json'),JSON.stringify(oracle,null,2)+'\n');
 const manifest=json(resolve(directory,'manifest.json'));
 for(const name of Object.keys(manifest.sha256))manifest.sha256[name]=fileHash(resolve(directory,name));
 writeFileSync(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
}
console.log(JSON.stringify({mode,jobs:rows.length,sha256:hash(serialized),matched:true}));
