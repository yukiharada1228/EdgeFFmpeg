import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
const sha=b=>createHash('sha256').update(b).digest('hex'),binary=resolve('.build/reference/ffmpeg'),binarySha256='1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
if(sha(readFileSync(binary))!==binarySha256)throw Error('Wrong Native');
const audio=Buffer.from(JSON.parse(readFileSync('compat/behavior-specs/flac-cli/cases.json')).input,'base64');
const picture=Buffer.from(JSON.parse(readFileSync('compat/behavior-specs/flac-pictures/native-pictures.json')).rows.find(r=>r.id==='bmp'&&r.transport==='block').payload,'base64');
let at=4,last=4;for(;;){last=at;const end=at+4+audio.readUIntBE(at+1,3);if(audio[at]&128){at=end;break;}at=end;}
const prefix=Buffer.from(audio.subarray(0,at));prefix[last]&=127;const header=Buffer.alloc(4);header[0]=134;header.writeUIntBE(picture.length,1,3);const input=Buffer.concat([prefix,header,picture,audio.subarray(at)]);
const expected=JSON.parse(readFileSync('compat/behavior-specs/flac-selection/cases.json')).inputs.pictured;if(sha(input)!==expected)throw Error('Input mismatch');
const root=mkdtempSync(join(tmpdir(),'flac-aiff-selection-')),rows=[];
try{writeFileSync(join(root,'in.flac'),input);for(const [id,options]of [['automatic',[]],['disable-video',['-vn']],['audio-map',['-map','0:a']]]){
 const args=['-i','/in.flac',...options,'-map_metadata','-1','-f','aiff','/out'];rmSync(join(root,'out'),{force:true});
 const run=spawnSync(binary,args.map(a=>a==='/in.flac'?join(root,'in.flac'):a==='/out'?join(root,'out'):a),{encoding:'utf8',timeout:10000});if(run.error||run.status===null)throw run.error??Error('Native failed');
 const output=existsSync(join(root,'out'))?readFileSync(join(root,'out')):null;
 rows.push({id,args,exitCode:run.status,output:output?.toString('base64')??null,outputSha256:output?sha(output):null,selected:[...run.stderr.matchAll(/Stream #0:(\d+) -> #0:\d+/g)].map(m=>Number(m[1])),stderr:run.stderr.replaceAll(root,'<fixture>')});
}writeFileSync('compat/behavior-specs/flac-decoded-selection/aiff-pictures.json',JSON.stringify({reference:'946fcce07b6dcd0331c8cc609192aeff5e1924f8',binarySha256,input:input.toString('base64'),inputSha256:sha(input),rows},null,2)+'\n');console.log(rows.map(r=>({id:r.id,exit:r.exitCode,selected:r.selected})));
}finally{rmSync(root,{recursive:true,force:true});}
