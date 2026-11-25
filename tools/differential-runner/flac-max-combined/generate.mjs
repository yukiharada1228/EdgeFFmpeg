import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {DRAFT_ENV,corpusTarget,writePlatformCorpus} from '../platform-corpus.mjs';import {LEGACY_CORPUS_PLATFORM,localReferenceIdentity} from '../reference-identity.mjs';import {scalarRow,scalarSelection} from './scalar.mjs';
// Records the 40 combined-feature Native rows for the verified pinned reference of this host. darwin-arm64 rewrites
// its tracked cases.json (scalar.mjs then extends scalar.json from it). Any other pin, and --draft, records cases.json
// and the 18 explicit -cpuflags 0 rows of scalar.json together into compat/behavior-specs/flac-max-combined/<pin id>/
// through platform-corpus.mjs, as tools/linux/generate-corpora.mjs runs it (committed only from the Linux probe corpora
// job; --draft writes under .build/linux-green/drafts/). remux-policy.json stays darwin-arm64 evidence.
const base='compat/behavior-specs/flac-max-combined',generator='tools/differential-runner/flac-max-combined/generate.mjs';
const identity=localReferenceIdentity(),draft=process.argv.includes('--draft')||process.env[DRAFT_ENV]==='1',target=identity.id===LEGACY_CORPUS_PLATFORM&&!draft?null:corpusTarget(base,generator);
const sha=b=>createHash('sha256').update(b).digest('hex'),binary=resolve('.build/reference/ffmpeg'),binarySha256=identity.ffmpeg;if(sha(readFileSync(binary))!==binarySha256)throw Error('Wrong reference');
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-decode-cli/cases.json')),wasmSha256=sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const plans=[
 ['remix-resample',[],['-ac','1','-ar','16000'],'s16le'],
 ['volume-remix',[],['-af','volume=0.5','-ac','1'],'s16le'],
 ['volume-resample',[],['-af','volume=0.5','-ar','11025'],'wav'],
 ['input-window',['-ss','0.005','-t','0.015'],[],'wav'],
 ['input-output-window',['-ss','0.005'],['-ss','0.003','-t','0.008'],'s16le'],
 ['output-to',[],['-ss','0.004','-to','0.016'],'wav'],
 ['reframe-limit',[],['-af','asetnsamples=n=40:p=1','-frames:a','2'],'framecrc'],
 ['asetrate-resample',[],['-af','asetrate=16000','-ar','8000'],'s16le'],
 ['pad-remix',[],['-af','apad=pad_len=11','-ac','1'],'wav'],
 ['fixed-volume',[],['-af','volume=2:precision=fixed','-c:a','pcm_s16le'],'s16le'],
];
const root=mkdtempSync(join(tmpdir(),'flac-max-combined-')),rows=[];
try{for(const profile of ['16-2-ramp-5','24-2-ramp-5']){
 const source=corpus.rows.find(r=>r.id===profile+'/s32le');if(!source)throw Error(profile);
 for(const unknown of [false,true]){const input=Buffer.from(source.input,'base64');if(unknown)input.writeBigUInt64BE(input.readBigUInt64BE(18)&~((1n<<36n)-1n),18);writeFileSync(join(root,'in.flac'),input);
  for(const [name,inputOptions,options,format]of plans){const args=[...inputOptions,'-i','/in.flac','-map','0:a','-map_metadata','-1',...options,'-f',format,'/out'];rmSync(join(root,'out'),{force:true});const run=spawnSync(binary,args.map(a=>a==='/in.flac'?join(root,'in.flac'):a==='/out'?join(root,'out'):a),{encoding:'utf8',timeout:10000,maxBuffer:1048576});if(run.error||run.status===null)throw run.error??Error('Native failed');const output=existsSync(join(root,'out'))?readFileSync(join(root,'out')):null;rows.push({id:profile+'/'+(unknown?'unknown/':'known/')+name,input:input.toString('base64'),inputSha256:sha(input),args,exitCode:run.status,output:output?.toString('base64')??null,outputSha256:output?sha(output):null,stderr:run.stderr.replaceAll(root,'<fixture>')});}
 }
}const cases={reference:'946fcce07b6dcd0331c8cc609192aeff5e1924f8',binarySha256,wasmSha256,rows};
 if(!target){writeFileSync(base+'/cases.json',JSON.stringify(cases,null,2)+'\n');console.log(JSON.stringify({actualNativeCalls:rows.length,successes:rows.filter(r=>r.exitCode===0).length}));}
 else{const scalar=scalarSelection(rows).map(row=>scalarRow(row,binary,root));if(scalar.length!==18)throw Error('Expected 18 scalar rows');writePlatformCorpus(target,{'cases.json':cases,'scalar.json':{...cases,rows:scalar}});console.log(JSON.stringify({actualNativeCalls:rows.length+scalar.length,successes:rows.filter(r=>r.exitCode===0).length,scalar:scalar.length,dir:target.dir}));}
}finally{rmSync(root,{recursive:true,force:true});}
