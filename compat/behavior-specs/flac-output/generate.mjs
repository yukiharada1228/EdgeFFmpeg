// Development-only pinned Native oracle; not imported by production.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const reference=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8'));
const binary='.build/reference/ffmpeg',binarySha256=hash(readFileSync(binary));
if(binarySha256!==reference.artifacts.ffmpeg)throw Error('Native reference changed');
const corpus=JSON.parse(readFileSync('.build/flac-investigation/native-cases.json','utf8'));
const root=mkdtempSync(join(tmpdir(),'flac-decode-backend-')),rows=[];
try{
 const sources=corpus.rows.filter(row=>row.channels===2&&row.level===5&&['empty','extremes','ramp'].includes(row.pattern));
 const formats=['aiff','au'];
 for(const source of sources){writeFileSync(join(root,'in.flac'),Buffer.from(source.flac,'base64'));
  for(const format of formats)for(const codec of [null,...(format==='aiff'?['pcm_s8','pcm_s16be','pcm_s24be','pcm_s32be','pcm_s16le','pcm_f32be','pcm_f64be','pcm_alaw','pcm_mulaw']:['pcm_s8','pcm_s16be','pcm_s24be','pcm_s32be','pcm_f32be','pcm_f64be','pcm_alaw','pcm_mulaw'])])for(const bitexact of [false,true]){const entry={};const args=['-i','/in.flac','-map','0:a','-map_metadata','-1',...(codec?['-c:a',codec]:[]),...(bitexact?['-bitexact']:[]),'-f',format,'/out'];
   const actual=args.map(arg=>arg==='/in.flac'?join(root,'in.flac'):arg==='/out'?join(root,'out'):arg);
   const result=spawnSync(binary,['-v','error','-y',...actual],{encoding:'utf8',timeout:10000});
   if(result.status!==0)throw Error(source.id+'/'+format+': '+result.stderr);
   const output=readFileSync(join(root,'out'));
   rows.push({id:source.id+'/'+format+(codec?'/'+codec:'')+(bitexact?'/bitexact':''),input:source.flac,inputSha256:source.flacSha256,args,output:output.toString('base64'),outputSha256:hash(output),exitCode:result.status});
  }
 }
 writeFileSync('compat/behavior-specs/flac-output/cases.json',JSON.stringify({reference,binarySha256,wasmSha256:hash(readFileSync('.build/codecs/flac/edge-flac.wasm')),rows},null,2)+'\n');
 console.log(JSON.stringify({cases:rows.length}));
}finally{rmSync(root,{recursive:true,force:true});}
