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
 const formats=['u8','s8','s16le','s16be','s24le','s24be','s32le','s32be','u16le','u16be','u24le','u24be','u32le','u32be','f32le','f32be','f64le','f64be','alaw','mulaw','wav','framecrc'];
 for(const source of sources){writeFileSync(join(root,'in.flac'),Buffer.from(source.flac,'base64'));
  for(const entry of [...formats.map(format=>({format,codec:null})),...['pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le','pcm_alaw','pcm_mulaw'].map(codec=>({format:'wav',codec})),...['pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'].map(codec=>({format:'framecrc',codec})),...['0','1'].map(limit=>({format:'framecrc',codec:null,limit})),{format:'s16le',codec:null,limit:'0'},{format:'wav',codec:null,limit:'0'}]){const {format,codec}=entry;const args=['-i','/in.flac','-map','0:a','-map_metadata','-1',...(codec?['-c:a',codec]:[]),...(entry.limit?['-frames:a',entry.limit]:[]),'-f',format,'/out'];
   const actual=args.map(arg=>arg==='/in.flac'?join(root,'in.flac'):arg==='/out'?join(root,'out'):arg);
   const result=spawnSync(binary,['-v','error','-y',...actual],{encoding:'utf8',timeout:10000});
   if(result.status!==0)throw Error(source.id+'/'+format+': '+result.stderr);
   const output=readFileSync(join(root,'out'));
   rows.push({id:source.id+'/'+format+(codec?'/'+codec:'')+(entry.limit?'/frames'+entry.limit:''),input:source.flac,inputSha256:source.flacSha256,args,output:output.toString('base64'),outputSha256:hash(output),exitCode:result.status});
  }
 }
 writeFileSync('compat/behavior-specs/flac-decode-cli/cases.json',JSON.stringify({reference,binarySha256,wasmSha256:hash(readFileSync('.build/codecs/flac/edge-flac.wasm')),rows},null,2)+'\n');
 console.log(JSON.stringify({cases:rows.length}));
}finally{rmSync(root,{recursive:true,force:true});}
