import {readFileSync,writeFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const sha=data=>createHash('sha256').update(data).digest('hex');
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-remix/cases.json'));
const binary=resolve('.build/reference/ffmpeg'),destination='compat/behavior-specs/flac-max-remix/arithmetic.json';
if(sha(readFileSync(binary))!==corpus.binarySha256)throw Error('Wrong Native binary');
if(existsSync(destination)){
 const saved=JSON.parse(readFileSync(destination));if(saved.binarySha256!==corpus.binarySha256||sha(Buffer.from(saved.scalarCase.output,'base64'))!==saved.scalarCase.outputSha256)throw Error('Invalid saved arithmetic evidence');
 console.log(JSON.stringify({actualNativeCalls:0,reused:3}));
}else{
 const input=Buffer.alloc(8);input.writeFloatLE(.734375,0);input.writeFloatLE(-.9765625,4);
 const probe=flags=>{
  const args=['-v','error',...flags,'-f','f32le','-ar','8000','-ac','2','-i','pipe:0','-ac','1','-f','f32le','pipe:1'];
  const output=execFileSync(binary,args,{input,timeout:10000,maxBuffer:1048576}),value=output.readFloatLE(0);
  const arithmetic=value===-.17125239968299866?'fused':value===-.17125242948532104?'separate':null;if(!arithmetic)throw Error('Unknown contraction profile');
  return {args,input:input.toString('base64'),output:output.toString('base64'),arithmetic,value};
 };
 const normal=probe([]),scalar=probe(['-cpuflags','0']);
 const row=corpus.rows.find(row=>row.id==='16-2-ramp-5/ac1/f32le'),root=mkdtempSync(join(tmpdir(),'flac-remix-arithmetic-'));
 try{
  writeFileSync(join(root,'in.flac'),Buffer.from(row.input,'base64'));const args=['-cpuflags','0',...row.args];
  const run=spawnSync(binary,args.map(arg=>arg==='/in.flac'?join(root,'in.flac'):arg==='/out'?join(root,'out'):arg),{encoding:'utf8',timeout:10000,maxBuffer:1048576});if(run.error||run.status!==0)throw run.error??Error(run.stderr);
  const output=readFileSync(join(root,'out'));
  const scalarCase={...row,id:row.id+'/scalar-contraction',args,output:output.toString('base64'),outputSha256:sha(output),stderr:run.stderr.replaceAll(root,'<fixture>')};
  writeFileSync(destination,JSON.stringify({binarySha256:corpus.binarySha256,reference:corpus.reference.commit,default:normal,scalar,scalarCase},null,2)+'\n');console.log(JSON.stringify({actualNativeCalls:3,default:normal.arithmetic,scalar:scalar.arithmetic}));
 }finally{rmSync(root,{recursive:true,force:true});}
}
