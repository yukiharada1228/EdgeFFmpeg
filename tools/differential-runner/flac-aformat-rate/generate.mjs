import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const sha=b=>createHash('sha256').update(b).digest('hex');
const binary=resolve('.build/reference/ffmpeg'), binarySha256='1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
if(sha(readFileSync(binary))!==binarySha256)throw Error('Wrong reference binary');
const path='compat/behavior-specs/flac-aformat-rate/cases.json';
const reference='946fcce07b6dcd0331c8cc609192aeff5e1924f8';
const wasmSha256=sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-decode-cli/cases.json'));
const plans=[
 ['flt-11025',[],[],'aformat=sample_fmts=flt','f32le','pcm_f32le',11025],
 ['s16p-48000',[],[],'aformat=sample_fmts=s16p','wav','pcm_s16le',48000],
 ['s32-4000',[],[],'aformat=sample_fmts=s32','s32le','pcm_s32le',4000],
 ['dblp-11025',[],[],'aformat=sample_fmts=dblp','f64le','pcm_f64le',11025],
 ['u8-48000',[],[],'aformat=sample_fmts=u8','u8','pcm_u8',48000],
 ['fltp-volume-4000',[],[],'aformat=sample_fmts=fltp,volume=0.5','wav','pcm_f32le',4000],
 ['volume-s16-11025',[],[],'volume=0.25,aformat=sample_fmts=s16','aiff','pcm_s16be',11025],
 ['dbl-au-48000',[],[],'aformat=sample_fmts=dbl','au','pcm_s16be',48000],
 ['flt-window-11025',[],['-ss','0.005123','-t','0.0101875'],'aformat=sample_fmts=flt','f32le','pcm_f32le',11025],
 ['s16p-input-48000',['-t','0.020125'],[],'aformat=sample_fmts=s16p','wav','pcm_s16le',48000],
 ['s32-to-4000',[],['-ss','0.004125','-to','0.0161875'],'aformat=sample_fmts=s32','s32le','pcm_s32le',4000],
 ['dblp-mixed-11025',['-to','0.026'],['-ss','0.005123','-t','0.0101875'],'aformat=sample_fmts=dblp','f64le','pcm_f64le',11025],
 ['u8-input-48000',['-t','0.021'],[],'aformat=sample_fmts=u8','u8','pcm_u8',48000],
 ['fltp-volume-window-4000',[],['-ss','0.005123','-t','0.012'],'aformat=sample_fmts=fltp,volume=0.5','wav','pcm_f32le',4000],
 ['volume-s16-window-11025',[],['-ss','0.005123','-t','0.012'],'volume=0.25,aformat=sample_fmts=s16','aiff','pcm_s16be',11025],
 ['dbl-au-input-48000',['-t','0.025'],['-ss','0.005123'],'aformat=sample_fmts=dbl','au','pcm_s16be',48000],
 ['s16-short-input-48000',['-t','0.0005'],[],'aformat=sample_fmts=s16','s16le','pcm_s16le',48000],
 ['fltp-short-input-48000',['-t','0.0005'],[],'aformat=sample_fmts=fltp','f32le','pcm_f32le',48000],
];
const previous=existsSync(path)?JSON.parse(readFileSync(path)):null;
if(previous&&(previous.reference!==reference||previous.binarySha256!==binarySha256||previous.wasmSha256!==wasmSha256))throw Error('Cached evidence pins differ');
const root=mkdtempSync(join(tmpdir(),'flac-aformat-rate-')),rows=[];let actualNativeCalls=0;
try{
 for(const [planIndex,[name,inputOptions,options,filter,format,codec,rate]] of plans.entries()){
  const profile=(planIndex>=16?1:planIndex%2)===0?'16-2-ramp-5':'24-2-ramp-5';
  const source=corpus.rows.find(r=>r.id===profile+'/s32le');if(!source)throw Error(profile);
  for(const unknown of [false,true]){
   const input=Buffer.from(source.input,'base64');
   const streamInfo=input.readBigUInt64BE(18);
   if(input.subarray(0,4).toString()!=='fLaC'||input[4]%128!==0||input.readUIntBE(5,3)!==34||Number(streamInfo>>44n)!==8000||Number((streamInfo>>41n)&7n)+1!==2||Number((streamInfo>>36n)&31n)+1!==(profile.startsWith('16-')?16:24)||Number(streamInfo&((1n<<36n)-1n))!==257)throw Error('Unexpected canonical STREAMINFO: '+profile);
   if(input.length>524288)throw Error('Input byte limit exceeded');
   if(unknown)input.writeBigUInt64BE(input.readBigUInt64BE(18)&~((1n<<36n)-1n),18);
   writeFileSync(join(root,'in.flac'),input);
    const id=profile+'/'+(unknown?'unknown/':'known/')+name;
    const args=['-cpuflags','0',...inputOptions,'-i','/in.flac','-map','0:a','-map_metadata','-1',...options,'-af',filter,'-ar',String(rate),'-c:a',codec,'-f',format,'/out'];
    const cached=previous?.rows.find(r=>r.id===id);
    if(cached){
     if(cached.inputSha256!==sha(input)||cached.input!==input.toString('base64')||JSON.stringify(cached.args)!==JSON.stringify(args)||JSON.stringify(cached.referenceArgs)!==JSON.stringify(['-loglevel','verbose',...args])||cached.outputSha256!==(cached.output===null?null:sha(Buffer.from(cached.output,'base64'))))throw Error('Cached row differs: '+id);
     if(cached.exitCode!==0||cached.output===null||Buffer.from(cached.output,'base64').length>524288)throw Error('Invalid cached result: '+id);
     rows.push(cached);continue;
    }
    if(process.argv.includes('--verify'))throw Error('Missing cached row: '+id);
    if(++actualNativeCalls>40)throw Error('Native call cap exceeded');
    rmSync(join(root,'out'),{force:true});
    const referenceArgs=['-loglevel','verbose',...args];
    const run=spawnSync(binary,referenceArgs.map(a=>a==='/in.flac'?join(root,'in.flac'):a==='/out'?join(root,'out'):a),{encoding:'utf8',timeout:10000,maxBuffer:1048576});
    if(run.error||run.status===null)throw run.error??Error('Native invocation failed');
    const output=existsSync(join(root,'out'))?readFileSync(join(root,'out')):null;
    if(run.status!==0||output===null)throw Error('Unexpected Native error: '+id+' '+run.stderr);
    if(input.length>524288||(output?.length??0)>524288)throw Error('Fixture byte limit exceeded');
    rows.push({id,input:input.toString('base64'),inputSha256:sha(input),args,referenceArgs,exitCode:run.status,stdout:run.stdout.replaceAll(root,'<fixture>'),stderr:run.stderr.replaceAll(root,'<fixture>'),output:output?.toString('base64')??null,outputSha256:output?sha(output):null});
    writeFileSync(path,JSON.stringify({reference,binarySha256,wasmSha256,rows},null,2)+'\n');
  }
 }
 console.log(JSON.stringify({actualNativeCalls,rows:rows.length,successes:rows.filter(r=>r.exitCode===0).length,cached:actualNativeCalls===0}));
}finally{rmSync(root,{recursive:true,force:true});}
