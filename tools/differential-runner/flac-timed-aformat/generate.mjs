import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DRAFT_ENV,corpusTarget,writePlatformCorpus} from '../platform-corpus.mjs';
import {LEGACY_CORPUS_PLATFORM,localReferenceIdentity} from '../reference-identity.mjs';
// Records Native rows for the verified pinned reference of this host. darwin-arm64 keeps its tracked cases.json,
// extended from verified cached rows (--verify executes nothing). Any other pin, and --draft, records every row afresh
// into compat/behavior-specs/flac-timed-aformat/<pin id>/ through platform-corpus.mjs, as tools/linux/generate-corpora.mjs runs it
// (committed only from the Linux probe corpora job; --draft writes under .build/linux-green/drafts/).
const sha=b=>createHash('sha256').update(b).digest('hex');
const base='compat/behavior-specs/flac-timed-aformat',generator='tools/differential-runner/flac-timed-aformat/generate.mjs';
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
 ['s16-output-window',[],['-ss','0.005123','-t','0.0101875'],'aformat=sample_fmts=s16','s16le','pcm_s16le'],
 ['s32-output-to',[],['-ss','0.004125','-to','0.0161875'],'aformat=sample_fmts=s32','wav','pcm_s32le'],
 ['flt-before-volume',[],['-ss','0.005123','-t','0.012'],'aformat=sample_fmts=flt,volume=0.5','f32le','pcm_f32le'],
 ['dbl-after-volume',[],['-ss','0.005123','-t','0.012'],'volume=0.25,aformat=sample_fmts=dbl','f64le','pcm_f64le'],
 ['u8-input-duration',['-t','0.0101875'],[],'aformat=sample_fmts=u8','u8','pcm_u8'],
 ['s16p-input-to',['-to','0.0141875'],[],'aformat=sample_fmts=s16p','wav','pcm_s16le'],
 ['s32p-mixed',['-t','0.020125'],['-ss','0.005123','-t','0.0083125'],'aformat=sample_fmts=s32p','s32le','pcm_s32le'],
 ['fltp-before-volume',['-to','0.026'],['-ss','0.005123','-to','0.017'],'aformat=sample_fmts=fltp,volume=0.5','wav','pcm_f32le'],
 ['dblp-after-volume',[],['-ss','0.005123','-t','0.01'],'volume=0.5,aformat=sample_fmts=dblp','framecrc','pcm_s16le'],
 ['u8p-output-to',[],['-ss','0.004125','-to','0.0161875'],'aformat=sample_fmts=u8p','framecrc','pcm_u8'],
 ['s16-empty-input',['-t','0'],[],'aformat=sample_fmts=s16','wav','pcm_s16le'],
 ['flt-zero-output',[],['-t','0'],'aformat=sample_fmts=flt','f32le','pcm_f32le'],
 ['s32-past-eof',[],['-ss','1','-t','0.002'],'aformat=sample_fmts=s32','wav','pcm_s32le'],
 ['s16-aiff',[],['-ss','0.005123','-t','0.0101875'],'aformat=sample_fmts=s16:sample_rates=8000:channel_layouts=stereo','aiff','pcm_s16be'],
 ['dbl-au',['-t','0.025'],['-ss','0.005123'],'aformat=sample_fmts=dbl:sample_rates=8000:channel_layouts=stereo','au','pcm_s16be'],
 ['u8-volume-roundtrip',[],['-ss','0.005123','-t','0.0101875'],'aformat=sample_fmts=u8,volume=0.5,aformat=sample_fmts=s16','s16le','pcm_s16le'],
 ['s16-aiff-format-only',[],['-ss','0.005123','-t','0.0101875'],'aformat=sample_fmts=s16','aiff','pcm_s16be'],
 ['dbl-au-format-only',['-t','0.025'],['-ss','0.005123'],'aformat=sample_fmts=dbl','au','pcm_s16be'],
];
const previous=!target&&existsSync(path)?JSON.parse(readFileSync(path)):null;
if(previous&&(previous.reference!==reference||previous.binarySha256!==binarySha256||previous.wasmSha256!==wasmSha256))throw Error('Cached evidence pins differ');
const root=mkdtempSync(join(tmpdir(),'flac-timed-aformat-')),rows=[];let actualNativeCalls=0;
try{
 for(const [planIndex,[name,inputOptions,options,filter,format,codec]] of plans.entries()){
  const profile=(planIndex===16?1:planIndex===17?0:planIndex%2)===0?'16-2-ramp-5':'24-2-ramp-5';
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
    if(++actualNativeCalls>40)throw Error('Native call cap exceeded');
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
