// Development-only Native corpus generation; never imported by runtime packages.
// Runs the bmp-rle oracle (node tools/differential-runner/build-oracle.mjs bmp-rle), linked against the pinned
// .build/reference of this host, over 1536 RLE row-capacity profiles.
//   --check   compare the tracked corpus of this host's pin with fresh Native results
//   --write   darwin-arm64 only: rewrite the tracked compat/behavior-specs/bmp corpus in place (its own layout)
//   (none) or --draft   any other pin: write compat/behavior-specs/bmp/<pin id>/ through platform-corpus.mjs, as
//             tools/linux/generate-corpora.mjs runs it (committed only from the Linux probe corpora job; --draft
//             writes under .build/linux-green/drafts/)
import {readFileSync,writeFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {LEGACY_CORPUS_PLATFORM,assertRecordedPin,loadReferencePins,localReferenceIdentity,platformCorpusDirFor} from '../reference-identity.mjs';
import {corpusTarget,verifyPlatformCorpusDir,writePlatformCorpus} from '../platform-corpus.mjs';
const args=process.argv.slice(2),mode=args[0]??'--platform';
if(args.length>1||args.length&&!['--check','--write','--draft'].includes(mode))throw Error('Expected --check, --write, --draft or no argument');
const root=process.cwd(),base='compat/behavior-specs/bmp',generator='tools/differential-runner/bmp-rle/generate.mjs',oracleSource='tools/differential-runner/bmp-rle/oracle.c';
const directory=resolve(root,base),oracleDirectory=resolve(root,'.build/oracles/bmp-rle'),binary=resolve(oracleDirectory,'native');
const json=path=>JSON.parse(readFileSync(path,'utf8')),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),fileHash=path=>hash(readFileSync(path));
const identity=localReferenceIdentity(root),pins=loadReferencePins(root),legacy=identity.id===LEGACY_CORPUS_PLATFORM;
if(mode==='--write'&&!legacy)throw Error(`--write rewrites the tracked ${LEGACY_CORPUS_PLATFORM} corpus; ${identity.id} corpora are written without arguments (tools/linux/generate-corpora.mjs)`);
const target=['--draft','--platform'].includes(mode)?corpusTarget(base,generator,{draft:mode==='--draft'||undefined}):null;
if(target?.legacyLayout&&!target.draft)throw Error(`${LEGACY_CORPUS_PLATFORM} keeps its tracked corpus in ${base}; regenerate it with --check or --write`);
const provenance=json(resolve(directory,'provenance.json')),oracle=json(resolve(oracleDirectory,'provenance.json')),lock=json(resolve(root,'compat/upstream.lock.json'));
function verify(){
 if(provenance.commit!==lock.commit||oracle.reference.commit!==lock.commit||execFileSync('git',['-C',resolve(root,'upstream/ffmpeg'),'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==lock.commit)throw Error('BMP target commit mismatch');
 for(const [path,digest]of Object.entries({...provenance.sources,...provenance.recipes}))if(fileHash(resolve(root,path))!==digest)throw Error('BMP source or recipe changed: '+path);
 if(fileHash(resolve(root,oracleSource))!==oracle.sourceSha256||fileHash(binary)!==oracle.binarySha256)throw Error('BMP oracle changed');
 for(const [path,digest]of Object.entries(oracle.librarySha256))if(fileHash(path)!==digest)throw Error('Native library changed: '+path);
 if(legacy){for(const [name,digest]of Object.entries(provenance.reference))if(fileHash(resolve(root,'.build/reference',name))!==digest)throw Error('Native binary changed: '+name);return;}
 // Any other pin: the oracle was built against this host's verified reference and links exactly its pinned libraries.
 assertRecordedPin(oracle.reference,identity.id,pins);if(JSON.stringify(oracle.reference)!==JSON.stringify(identity.metadata))throw Error('BMP oracle was built against another reference build');
 const linked=Object.fromEntries(Object.entries(oracle.librarySha256).map(([path,digest])=>[relative(resolve(root,'.build/reference'),path),digest]));
 if(JSON.stringify(Object.entries(linked).sort())!==JSON.stringify(Object.entries(identity.libraries).sort()))throw Error(`BMP oracle libraries are not the pinned ${identity.id} libraries`);
 for(const name of ['ffmpeg','ffprobe'])if(fileHash(resolve(root,'.build/reference',name))!==identity[name])throw Error('Native binary changed: '+name);
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
const serialized=JSON.stringify(rows,null,2)+'\n';
// The oracle record of a platform corpus names checkout-relative paths, so it does not depend on where the job ran.
const portableOracle=()=>({...oracle,source:oracleSource,librarySha256:Object.fromEntries(Object.entries(oracle.librarySha256).map(([path,digest])=>[relative(root,path),digest]))});
if(mode==='--check'){
 const tracked=platformCorpusDirFor(base,identity.id,pins);
 if(!legacy)verifyPlatformCorpusDir(tracked,identity.id,{root,pins});
 if(readFileSync(resolve(root,tracked,'rle-profiles.json'),'utf8')!==serialized)throw Error(`Cached ${identity.id} BMP corpus differs from fresh Native results`);
 if(!legacy&&json(resolve(root,tracked,'oracle-provenance.json')).sourceSha256!==oracle.sourceSha256)throw Error(`Cached ${identity.id} BMP corpus was recorded with another oracle source`);
}else if(mode==='--write'){
 writeFileSync(resolve(directory,'rle-profiles.json'),serialized);writeFileSync(resolve(directory,'oracle-provenance.json'),JSON.stringify(oracle,null,2)+'\n');
 const manifest=json(resolve(directory,'manifest.json'));
 for(const name of Object.keys(manifest.sha256))manifest.sha256[name]=fileHash(resolve(directory,name));
 writeFileSync(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
}else writePlatformCorpus(target,{'rle-profiles.json':serialized,'oracle-provenance.json':portableOracle()},{root});
console.log(JSON.stringify({mode,reference:identity.id,jobs:rows.length,sha256:hash(serialized),matched:true,...(target?{dir:target.dir}:{})}));
