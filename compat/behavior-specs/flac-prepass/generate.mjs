// Development-only independent Native byte oracle.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const hash=b=>createHash('sha256').update(b).digest('hex'),binary='.build/reference/ffmpeg';
const reference=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')),binarySha256=hash(readFileSync(binary));
if(binarySha256!==reference.artifacts.ffmpeg)throw Error('Reference changed');
const root=mkdtempSync(join(tmpdir(),'flac-prepass-')),rows=[];
function run(args){const result=spawnSync(binary,['-v','error','-y',...args],{encoding:'utf8',timeout:10000});if(result.status!==0)throw Error(result.stderr);return result;}
try{
 for(const samples of [0,257,1000]){
  const pcm=Buffer.alloc(samples*4);for(let i=0;i<samples;i++){pcm.writeInt16LE(((i*901)%65536)-32768,i*4);pcm.writeInt16LE(32767-((i*433)%65536),i*4+2);}writeFileSync(join(root,'in.pcm'),pcm);
  run(['-f','s16le','-ar','8000','-ac','2','-i',join(root,'in.pcm'),'-c:a','flac','-frame_size','192',join(root,'source.flac')]);
  const known=readFileSync(join(root,'source.flac'));
  for(const unknown of [false,true]){const input=Buffer.from(known);if(unknown)input.writeBigUInt64BE(input.readBigUInt64BE(18)&~((1n<<36n)-1n),18);writeFileSync(join(root,'in.flac'),input);
   for(const format of ['wav','s16le','framecrc'])for(const limit of [null,0,1,2,99])for(const alias of limit===null?['-frames:a']:['-frames:a','-aframes']){
    const args=['-i','/in.flac','-map','0:a','-map_metadata','-1',...(limit===null?[]:[alias,String(limit)]),'-f',format,'/out'];
    const result=run(args.map(x=>x==='/in.flac'?join(root,'in.flac'):x==='/out'?join(root,'out'):x)),output=readFileSync(join(root,'out'));
    rows.push({id:`${samples}/${unknown?'unknown':'known'}/${format}/${alias}/${limit??'all'}`,input:input.toString('base64'),inputSha256:hash(input),args,output:output.toString('base64'),outputSha256:hash(output),exitCode:result.status});
   }
  }
 }
 writeFileSync('compat/behavior-specs/flac-prepass/cases.json',JSON.stringify({reference,binarySha256,wasmSha256:hash(readFileSync('.build/codecs/flac/edge-flac.wasm')),rows},null,2)+'\n');console.log(JSON.stringify({calls:rows.length+3,rows:rows.length}));
}finally{rmSync(root,{recursive:true,force:true});}
