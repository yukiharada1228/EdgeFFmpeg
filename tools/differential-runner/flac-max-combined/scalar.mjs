import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const sha=b=>createHash('sha256').update(b).digest('hex');
const original=JSON.parse(readFileSync('compat/behavior-specs/flac-max-combined/cases.json'));
const binary=resolve('.build/reference/ffmpeg'),destination='compat/behavior-specs/flac-max-combined/scalar.json';
if(sha(readFileSync(binary))!==original.binarySha256)throw Error('Wrong Native binary');
let rows=[];
if(existsSync(destination)){
 const saved=JSON.parse(readFileSync(destination));
 if(saved.binarySha256!==original.binarySha256||saved.rows.some(row=>sha(Buffer.from(row.input,'base64'))!==row.inputSha256||sha(Buffer.from(row.output,'base64'))!==row.outputSha256))throw Error('Invalid saved scalar evidence');
 rows=saved.rows;
}
const selected=original.rows.filter(row=>row.args.includes('-ar')||row.id.endsWith('/volume-remix')||row.id.startsWith('24-')&&row.id.endsWith('/pad-remix'));
const missing=selected.filter(row=>!rows.some(saved=>saved.id===row.id+'/scalar'));
{
 const root=mkdtempSync(join(tmpdir(),'flac-combined-scalar-'));
 try{
  for(const row of missing){
   const input=Buffer.from(row.input,'base64');if(sha(input)!==row.inputSha256)throw Error('Wrong input');
   writeFileSync(join(root,'in.flac'),input);rmSync(join(root,'out'),{force:true});
   const args=['-cpuflags','0',...row.args];
   const run=spawnSync(binary,args.map(arg=>arg==='/in.flac'?join(root,'in.flac'):arg==='/out'?join(root,'out'):arg),{encoding:'utf8',timeout:10000,maxBuffer:1048576});
   if(run.error||run.status!==0)throw run.error??Error(run.stderr);
   const output=readFileSync(join(root,'out'));if(output.length>524288)throw Error('Output bound');
   rows.push({...row,id:row.id+'/scalar',args,exitCode:run.status,output:output.toString('base64'),outputSha256:sha(output),stderr:run.stderr.replaceAll(root,'<fixture>')});
  }
  writeFileSync(destination,JSON.stringify({...original,rows},null,2)+'\n');console.log(JSON.stringify({actualNativeCalls:missing.length,reused:rows.length-missing.length,total:rows.length}));
 }finally{rmSync(root,{recursive:true,force:true});}
}
