// Development-only oracle generator. Native calls are strictly sequential.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const binary=resolve('.build/reference/ffmpeg'),root=mkdtempSync(join(tmpdir(),'flac-cli-'));
function native(args){const r=spawnSync(binary,['-v','error',...args],{encoding:'utf8',timeout:10000});if(r.status!==0)throw Error(r.stderr);return r.stdout;}
try{
 const samples=new Int16Array(2400);for(let i=0;i<samples.length;i++)samples[i]=(i*137)%20000-10000;
 writeFileSync(join(root,'audio.raw'),new Uint8Array(samples.buffer));
 native(['-f','s16le','-ar','8000','-ac','1','-i',join(root,'audio.raw'),'-c:a','flac','-metadata','title=fresh CLI fixture','-y',join(root,'input.flac')]);
 const input=readFileSync(join(root,'input.flac')),rows=[];
 for(const [id,opts] of [['auto',[]],['explicit',['-f','flac']],['audio-map',['-map','0:a:0']],['optional-video-fallback',['-map','0:v?']],['optional-negative-fallback',['-map','-0:a?']],['optional-negative-then-positive',['-map','-0:a?','-map','0:a']],['duplicate',['-map','0:a','-map','0:a']],['limit',['-frames:a','1']],['zero',['-frames:a','0']],['metadata',['-map_metadata','-1','-metadata','title=changed']],['bitexact',['-bitexact']]]){
 const inputOptions=id==='explicit'?opts:[],outputOptions=id==='explicit'?[]:opts,args=[...inputOptions,'-i','/input.bin','-c','copy',...outputOptions,'-f','framecrc','/output.crc'];
 const stdout=native(['-y',...inputOptions,'-i',join(root,'input.flac'),'-c','copy',...outputOptions,'-f','framecrc','-']);rows.push({id,args,stdout});
 }
 const errors=[];
 for(const [id,options] of [['missing-stream',['-map','0:3']],['no-audio',['-an']]]){const r=spawnSync(binary,['-v','error','-i',join(root,'input.flac'),...options,'-c','copy','-f','framecrc','-'],{encoding:'utf8',timeout:10000});errors.push({id,options,exitCode:r.status,stderr:r.stderr.replaceAll(root,'<fixture>')});}
 writeFileSync('compat/behavior-specs/flac-cli/cases.json',JSON.stringify({commit:'946fcce07b6dcd0331c8cc609192aeff5e1924f8',binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),version:native(['-version']).split('\n')[0],input:input.toString('base64'),rows,errors},null,2)+'\n');
}finally{rmSync(root,{recursive:true,force:true});}
