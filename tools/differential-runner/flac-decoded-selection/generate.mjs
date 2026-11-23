import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const binary=resolve('.build/reference/ffmpeg'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const binarySha256='1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
if(sha(readFileSync(binary))!==binarySha256)throw Error('Wrong pinned reference');
const previous=JSON.parse(readFileSync('compat/behavior-specs/flac-decode-cli/cases.json','utf8')).rows.find(row=>row.id==='16-2-extremes-5/s16le');
const input=Buffer.from(previous.input,'base64'),root=mkdtempSync(join(tmpdir(),'edge-decoded-selection-'));
const patterns=[[],['0:v?'],['-0:v?'],['0:2?'],['0:a','-0:v'],['0:a','-0:v?'],['0:a','-0:a','0:a'],['0:a','-0:a?'],['0','-0:a'],['-0:a'],['0:v'],['0:a:1?'],['0:a','0:2?']];
const rows=[];
try{
 writeFileSync(join(root,'in.flac'),input);
 for(const [index,maps]of patterns.entries()){
  const args=['-i','/in.flac',...maps.flatMap(map=>['-map',map]),'-map_metadata','-1','-f','s16le','/out'];
  rmSync(join(root,'out'),{force:true});
  const result=spawnSync(binary,args.map(arg=>arg==='/in.flac'?join(root,'in.flac'):arg==='/out'?join(root,'out'):arg),{encoding:'utf8',timeout:10000});
  if(result.error||result.status===null)throw result.error??Error('Reference did not terminate');
  const output=existsSync(join(root,'out'))?readFileSync(join(root,'out')):null;
  rows.push({id:String(index),maps,args,exitCode:result.status,output:output?.toString('base64')??null,outputSha256:output?sha(output):null,stderr:result.stderr.replaceAll(root,'<fixture>')});
 }
 writeFileSync('compat/behavior-specs/flac-decoded-selection/cases.json',JSON.stringify({reference:'946fcce07b6dcd0331c8cc609192aeff5e1924f8',binarySha256,input:input.toString('base64'),inputSha256:sha(input),rows},null,2)+'\n');
 console.log('Captured '+rows.length+' actual pinned Native decoded selection cases');
}finally{rmSync(root,{recursive:true,force:true});}
