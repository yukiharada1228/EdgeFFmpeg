import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const sha=b=>createHash('sha256').update(b).digest('hex');
const binary=resolve('.build/reference/ffmpeg'), binarySha256='1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
if(sha(readFileSync(binary))!==binarySha256)throw Error('Wrong reference binary');
const path='compat/behavior-specs/flac-timed-filters/cases.json';
const reference='946fcce07b6dcd0331c8cc609192aeff5e1924f8';
const wasmSha256=sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-decode-cli/cases.json'));
const plans=[
 ['output-window',[],['-ss','0.0001875','-t','0.0083125','-af','volume=0.5'],'s16le'],
 ['output-to',[],['-ss','0.004125','-to','0.0161875','-af','anull,volume=0.25'],'wav'],
 ['input-duration',['-t','0.0101875'],['-af','volume=2:precision=fixed'],'framecrc'],
 ['input-to-output-start',['-to','0.0141875'],['-ss','0.0031875','-af','anull'],'s16le'],
 ['past-eof',[],['-ss','1','-t','0.002','-af','volume=0.5'],'wav'],
 ['zero-duration',[],['-t','0','-af','anull'],'framecrc'],
];
const previous=existsSync(path)?JSON.parse(readFileSync(path)):null;
if(previous&&(previous.reference!==reference||previous.binarySha256!==binarySha256||previous.wasmSha256!==wasmSha256))throw Error('Cached evidence pins differ');
const root=mkdtempSync(join(tmpdir(),'flac-timed-filters-')),rows=[];let actualNativeCalls=0;
try{
 for(const profile of ['16-2-ramp-5','24-2-ramp-5','16-2-ramp-257']){
  const source=profile==='16-2-ramp-257' ? JSON.parse(readFileSync('compat/behavior-specs/flac-max-time/cases.json')).rows.find(r=>r.id==='baseline/raw') : corpus.rows.find(r=>r.id===profile+'/s32le');if(!source)throw Error(profile);
  for(const unknown of [false,true]){
   const input=Buffer.from(source.input,'base64');
   if(unknown)input.writeBigUInt64BE(input.readBigUInt64BE(18)&~((1n<<36n)-1n),18);
   writeFileSync(join(root,'in.flac'),input);
   for(const [name,inputOptions,options,format] of plans){
    const id=profile+'/'+(unknown?'unknown/':'known/')+name;
    const args=['-cpuflags','0',...inputOptions,'-i','/in.flac','-map','0:a','-map_metadata','-1',...options,'-f',format,'/out'];
    const cached=previous?.rows.find(r=>r.id===id);
    if(cached){
     if(cached.inputSha256!==sha(input)||cached.input!==input.toString('base64')||JSON.stringify(cached.args)!==JSON.stringify(args)||cached.outputSha256!==(cached.output===null?null:sha(Buffer.from(cached.output,'base64'))))throw Error('Cached row differs: '+id);
     rows.push(cached);continue;
    }
    if(++actualNativeCalls>40)throw Error('Native call cap exceeded');
    rmSync(join(root,'out'),{force:true});
    const run=spawnSync(binary,args.map(a=>a==='/in.flac'?join(root,'in.flac'):a==='/out'?join(root,'out'):a),{encoding:'utf8',timeout:10000,maxBuffer:1048576});
    if(run.error||run.status===null)throw run.error??Error('Native invocation failed');
    const output=existsSync(join(root,'out'))?readFileSync(join(root,'out')):null;
    rows.push({id,input:input.toString('base64'),inputSha256:sha(input),args,exitCode:run.status,stdout:run.stdout.replaceAll(root,'<fixture>'),stderr:run.stderr.replaceAll(root,'<fixture>'),output:output?.toString('base64')??null,outputSha256:output?sha(output):null});
    writeFileSync(path,JSON.stringify({reference,binarySha256,wasmSha256,rows},null,2)+'\n');
   }
  }
 }
 console.log(JSON.stringify({actualNativeCalls,rows:rows.length,successes:rows.filter(r=>r.exitCode===0).length,cached:actualNativeCalls===0}));
}finally{rmSync(root,{recursive:true,force:true});}
