import {readFileSync,writeFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const sha=data=>createHash('sha256').update(data).digest('hex');
const reference=JSON.parse(readFileSync('compat/behavior-specs/flac-max-remux/cases.json'));
const destination='compat/behavior-specs/flac-max-combined/remux-policy.json',binary=resolve('.build/reference/ffmpeg');
if(sha(readFileSync(binary))!==reference.binarySha256)throw Error('Wrong Native binary');
if(existsSync(destination)){
 const saved=JSON.parse(readFileSync(destination));if(saved.binarySha256!==reference.binarySha256||saved.rows.length!==1||saved.rows.some(row=>sha(Buffer.from(row.input,'base64'))!==row.inputSha256||sha(Buffer.from(row.output,'base64'))!==row.outputSha256))throw Error('Invalid evidence');
 console.log(JSON.stringify({actualNativeCalls:0,reused:1}));
}else{
 const source=reference.rows.find(row=>row.id==='16-2-ramp-5/default'),root=mkdtempSync(join(tmpdir(),'flac-remux-policy-'));
 try{
  const input=Buffer.from(source.input,'base64');if(sha(input)!==source.inputSha256)throw Error('Wrong input');
  writeFileSync(join(root,'in.flac'),input);const args=[...source.args];args.splice(args.length-1,0,'-map_chapters','-1','-metadata_header_padding','0','-metadata','title=verified copy');
  const run=spawnSync(binary,args.map(arg=>arg==='/in.flac'?join(root,'in.flac'):arg==='/out'?join(root,'out'):arg),{encoding:'utf8',timeout:10000,maxBuffer:1048576});if(run.error||run.status!==0)throw run.error??Error(run.stderr);
  const output=readFileSync(join(root,'out'));if(output.length>524288)throw Error('Output bound');
  const row={id:'16-2-ramp-5/explicit-metadata-padding',input:source.input,inputSha256:source.inputSha256,args,exitCode:run.status,output:output.toString('base64'),outputSha256:sha(output),stderr:run.stderr.replaceAll(root,'<fixture>')};
  writeFileSync(destination,JSON.stringify({reference:reference.reference,binarySha256:reference.binarySha256,rows:[row]},null,2)+'\n');console.log(JSON.stringify({actualNativeCalls:1}));
 }finally{rmSync(root,{recursive:true,force:true});}
}
