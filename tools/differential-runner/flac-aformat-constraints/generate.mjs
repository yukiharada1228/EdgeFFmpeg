import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const sha=b=>createHash('sha256').update(b).digest('hex');
const binary=resolve('.build/reference/ffmpeg'), binarySha256='1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
if(sha(readFileSync(binary))!==binarySha256)throw Error('Wrong reference binary');
const path='compat/behavior-specs/flac-aformat-constraints/cases.json';
const reference='946fcce07b6dcd0331c8cc609192aeff5e1924f8';
const wasmSha256=sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-decode-cli/cases.json'));
const plans=[
 ['rate',[],[],'aformat=sample_rates=8000','s16le','pcm_s16le'],
 ['layout',[],[],'aformat=channel_layouts=stereo','wav','pcm_s32le'],
 ['both-window',[],['-ss','0.005123','-t','0.0101875'],'aformat=sample_rates=8000:channel_layouts=stereo','s16le','pcm_s16le'],
 ['s16-constraints-input',['-t','0.020125'],[],'aformat=sample_fmts=s16:sample_rates=8000:channel_layouts=stereo','wav','pcm_s16le'],
 ['aliases-window',[],['-ss','0.005123','-to','0.017'],'aformat=r=8000:cl=stereo','aiff','pcm_s16be'],
 ['volume-before-dbl',[],['-ss','0.005123','-t','0.012'],'volume=0.5,aformat=sample_fmts=dbl:r=8000:cl=stereo','f64le','pcm_f64le'],
 ['volume-after-s16',['-to','0.026'],['-ss','0.005123'],'aformat=sample_fmts=s16:sample_rates=8000:channel_layouts=stereo,volume=0.25','au','pcm_s16be'],
 ['zero-output',[],['-t','0'],'aformat=r=8000:cl=stereo','wav','pcm_s16le'],
];
const previous=existsSync(path)?JSON.parse(readFileSync(path)):null;
if(previous&&(previous.reference!==reference||previous.binarySha256!==binarySha256||previous.wasmSha256!==wasmSha256))throw Error('Cached evidence pins differ');
const root=mkdtempSync(join(tmpdir(),'flac-aformat-constraints-')),rows=[];let actualNativeCalls=0;
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
    if(++actualNativeCalls>24)throw Error('Native call cap exceeded');
    rmSync(join(root,'out'),{force:true});
    const run=spawnSync(binary,args.map(a=>a==='/in.flac'?join(root,'in.flac'):a==='/out'?join(root,'out'):a),{encoding:'utf8',timeout:10000,maxBuffer:1048576});
    if(run.error||run.status===null)throw run.error??Error('Native invocation failed');
    const output=existsSync(join(root,'out'))?readFileSync(join(root,'out')):null;
    if(run.status!==0||output===null)throw Error('Unexpected Native error: '+id+' '+run.stderr);
    if(input.length>524288||(output?.length??0)>524288)throw Error('Fixture byte limit exceeded');
    rows.push({id,input:input.toString('base64'),inputSha256:sha(input),args,exitCode:run.status,stdout:run.stdout.replaceAll(root,'<fixture>'),stderr:run.stderr.replaceAll(root,'<fixture>'),output:output?.toString('base64')??null,outputSha256:output?sha(output):null});
    writeFileSync(path,JSON.stringify({reference,binarySha256,wasmSha256,rows},null,2)+'\n');
  }
 }
 console.log(JSON.stringify({actualNativeCalls,rows:rows.length,successes:rows.filter(r=>r.exitCode===0).length,cached:actualNativeCalls===0}));
}finally{rmSync(root,{recursive:true,force:true});}
