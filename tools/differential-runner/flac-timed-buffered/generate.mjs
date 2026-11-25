import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DRAFT_ENV,corpusTarget,writePlatformCorpus} from '../platform-corpus.mjs';
import {LEGACY_CORPUS_PLATFORM,localReferenceIdentity} from '../reference-identity.mjs';
// Records Native rows for the verified pinned reference of this host. darwin-arm64 keeps its tracked cases.json,
// extended from verified cached rows (--verify executes nothing). Any other pin, and --draft, records every row afresh
// into compat/behavior-specs/flac-timed-buffered/<pin id>/ through platform-corpus.mjs, as tools/linux/generate-corpora.mjs runs it
// (committed only from the Linux probe corpora job; --draft writes under .build/linux-green/drafts/).
const sha=b=>createHash('sha256').update(b).digest('hex');
const base='compat/behavior-specs/flac-timed-buffered',generator='tools/differential-runner/flac-timed-buffered/generate.mjs';
const identity=localReferenceIdentity(),draft=process.argv.includes('--draft')||process.env[DRAFT_ENV]==='1';
const target=identity.id===LEGACY_CORPUS_PLATFORM&&!draft?null:corpusTarget(base,generator);
if(target&&process.argv.includes('--verify'))throw Error(`--verify validates the tracked ${LEGACY_CORPUS_PLATFORM} cache; ${identity.id} corpora are recorded afresh`);
const binary=resolve('.build/reference/ffmpeg'), binarySha256=identity.ffmpeg;
if(sha(readFileSync(binary))!==binarySha256)throw Error('Wrong reference binary');
const path=base+'/cases.json';
const reference='946fcce07b6dcd0331c8cc609192aeff5e1924f8';
const wasmSha256=sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-decode-cli/cases.json'));
const plans=[
 ['apad-window',[],['-ss','0.005123','-t','0.0101875'],'apad=pad_len=64','s16le','pcm_s16le'],
 ['apad-padding-window',[],['-ss','0.033','-t','0.005'],'apad=pad_len=64','wav','pcm_s16le'],
 ['whole-len-to',[],['-ss','0.030125','-to','0.040125'],'apad=whole_len=400','framecrc','pcm_s16le'],
 ['tiny-input-apad',['-t','0.0005'],['-ss','0.00025','-t','0.005'],'apad=pad_len=64','wav','pcm_s16le'],
 ['input-to-volume-pad',['-to','0.010125'],['-ss','0.008','-t','0.008'],'volume=0.5,apad=whole_len=200','s16le','pcm_s16le'],
 ['format-pad-volume',[],['-ss','0.031','-t','0.008'],'aformat=sample_fmts=flt,apad=pad_len=64,volume=0.25','f32le','pcm_f32le'],
 ['aset-p0-window',[],['-ss','0.005123','-t','0.020125'],'asetnsamples=n=64:p=0','framecrc','pcm_s16le'],
 ['aset-p1-window',[],['-ss','0.030125','-t','0.008'],'asetnsamples=n=64:p=1','wav','pcm_s16le'],
 ['input-duration-aset',['-t','0.010125'],['-ss','0.004','-to','0.014'],'asetnsamples=n=64:p=1','aiff','pcm_s16be'],
 ['aset-volume-pad',['-t','0.020125'],['-ss','0.019','-t','0.012'],'asetnsamples=n=64:p=0,volume=0.5,apad=pad_len=64','au','pcm_s16be'],
 ['apad-zero-output',[],['-t','0'],'apad=pad_len=64','wav','pcm_s16le'],
 ['aset-frame-limit',[],['-ss','0.005123','-t','0.020125','-frames:a','2'],'asetnsamples=n=64:p=1','framecrc','pcm_s16le'],
];
const previous=!target&&existsSync(path)?JSON.parse(readFileSync(path)):null;
if(previous&&(previous.reference!==reference||previous.binarySha256!==binarySha256||previous.wasmSha256!==wasmSha256))throw Error('Cached evidence pins differ');
const root=mkdtempSync(join(tmpdir(),'flac-timed-buffered-')),rows=[];let actualNativeCalls=0;
try{
 for(const [planIndex,[name,inputOptions,options,filter,format,codec]] of plans.entries()){
  const profile=(planIndex%2)===0?'16-2-ramp-5':'24-2-ramp-5';
  const source=corpus.rows.find(r=>r.id===profile+'/s32le');if(!source)throw Error(profile);
  for(const unknown of [false,true]){
   const input=Buffer.from(source.input,'base64');
   const streamInfo=input.readBigUInt64BE(18);
   if(input.subarray(0,4).toString()!=='fLaC'||input[4]%128!==0||input.readUIntBE(5,3)!==34||Number(streamInfo>>44n)!==8000||Number((streamInfo>>41n)&7n)+1!==2||Number((streamInfo>>36n)&31n)+1!==(profile.startsWith('16-')?16:24)||Number(streamInfo&((1n<<36n)-1n))!==257)throw Error('Unexpected canonical STREAMINFO: '+profile);
   if(input.length>524288)throw Error('Input byte limit exceeded');
   if(unknown)input.writeBigUInt64BE(input.readBigUInt64BE(18)&~((1n<<36n)-1n),18);
   writeFileSync(join(root,'in.flac'),input);
    const id=profile+'/'+(unknown?'unknown/':'known/')+name;
    const args=['-cpuflags','0',...inputOptions,'-i','/in.flac','-map','0:a','-map_metadata','-1',...options,'-af',filter,'-c:a',codec,'-f',format,'/out'];
    const cached=previous?.rows.find(r=>r.id===id);
    if(cached){
     if(cached.inputSha256!==sha(input)||cached.input!==input.toString('base64')||JSON.stringify(cached.args)!==JSON.stringify(args)||cached.outputSha256!==(cached.output===null?null:sha(Buffer.from(cached.output,'base64'))))throw Error('Cached row differs: '+id);
     if(cached.exitCode!==0||cached.output===null||Buffer.from(cached.output,'base64').length>524288)throw Error('Invalid cached result: '+id);
     rows.push(cached);continue;
    }
    if(process.argv.includes('--verify'))throw Error('Missing cached row: '+id);
    if(++actualNativeCalls>32)throw Error('Native call cap exceeded');
    rmSync(join(root,'out'),{force:true});
    const run=spawnSync(binary,args.map(a=>a==='/in.flac'?join(root,'in.flac'):a==='/out'?join(root,'out'):a),{encoding:'utf8',timeout:10000,maxBuffer:1048576});
    if(run.error||run.status===null)throw run.error??Error('Native invocation failed');
    const output=existsSync(join(root,'out'))?readFileSync(join(root,'out')):null;
    if(run.status!==0||output===null)throw Error('Unexpected Native error: '+id+' '+run.stderr);
    if(input.length>524288||(output?.length??0)>524288)throw Error('Fixture byte limit exceeded');
    rows.push({id,input:input.toString('base64'),inputSha256:sha(input),args,exitCode:run.status,stdout:run.stdout.replaceAll(root,'<fixture>'),stderr:run.stderr.replaceAll(root,'<fixture>'),output:output?.toString('base64')??null,outputSha256:output?sha(output):null});
    if(!target)writeFileSync(path,JSON.stringify({reference,binarySha256,wasmSha256,rows},null,2)+'\n');
  }
 }
 if(target)writePlatformCorpus(target,{'cases.json':{reference,binarySha256,wasmSha256,rows}});
 console.log(JSON.stringify({actualNativeCalls,rows:rows.length,successes:rows.filter(r=>r.exitCode===0).length,cached:actualNativeCalls===0,...(target?{dir:target.dir}:{})}));
}finally{rmSync(root,{recursive:true,force:true});}
