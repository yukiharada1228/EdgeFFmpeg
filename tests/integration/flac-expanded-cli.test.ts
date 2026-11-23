import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {it,expect} from 'vitest';

interface Row {id:string;input:string;inputSha256:string;args:string[];output:string;outputSha256:string;exitCode:number}
interface Corpus {wasmSha256:string;rows:Row[]}
const load=(name:string)=>JSON.parse(readFileSync(`compat/behavior-specs/${name}/cases.json`,'utf8')) as Corpus;
const output=load('flac-output'),prepass=load('flac-prepass');
const modulePath=resolve('.build/codecs/flac/edge-flac.wasm');
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function rowIn(corpus:Corpus,id:string){const row=corpus.rows.find(row=>row.id===id);if(!row)throw Error(`Missing required Native case ${id}`);return row;}
function launch(root:string,args:string[],settings:string[]=['--flac-wasm',modulePath]){
 return spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,...settings,'--',...args],{encoding:'utf8',timeout:20000});
}
function verify(root:string,row:Row,args:string[]){
 const result=launch(root,args);expect(result.error,row.id).toBeUndefined();expect(result.signal,row.id).toBeNull();
 expect(result.status,row.id+result.stderr).toBe(row.exitCode);
 const summary=JSON.parse(result.stdout) as {exitCode:number;outputs:string[];diagnostics:unknown[]};
 expect(summary).toMatchObject({exitCode:0,outputs:['/out'],diagnostics:[]});
 const actual=readFileSync(join(root,'out')),expected=Buffer.from(row.output,'base64');
 expect(actual.length,row.id).toBe(expected.length);expect(sha(actual),row.id).toBe(row.outputSha256);expect(actual.equals(expected),row.id).toBe(true);
 expect(readdirSync(root).sort()).toEqual(['in.flac','out']);
}
it('requires the actual pinned Wasm and expanded Native fixture inputs',()=>{
 const hash=sha(readFileSync(modulePath));expect(hash).toBe(output.wasmSha256);expect(hash).toBe(prepass.wasmSha256);
 for(const corpus of [output,prepass])for(const row of corpus.rows){expect(sha(Buffer.from(row.input,'base64')),row.id).toBe(row.inputSha256);expect(sha(Buffer.from(row.output,'base64')),row.id).toBe(row.outputSha256);}
});
for(const id of ['32-2-extremes-5/aiff/pcm_s16le','24-2-ramp-5/aiff/pcm_f64be/bitexact','16-2-extremes-5/au/pcm_alaw','32-2-ramp-5/au/pcm_f32be/bitexact']){
 it(`launches Native ${id} with unknown totals and ordered codec aliases`,()=>{
  const root=mkdtempSync(join(tmpdir(),'edge-flac-expanded-')),row=rowIn(output,id),codec=row.args[row.args.indexOf('-c:a')+1]!;
  try{
   // Clearing only STREAMINFO's total leaves the same independently generated
   // audio and Native expected output; no encoder or oracle runs in acceptance.
   for(const [index,alias] of ['-c','-c:a','-acodec'].entries()){
    const bytes=Buffer.from(row.input,'base64');if(index!==0){bytes[21]=bytes[21]!&0xf0;bytes.fill(0,22,26);}
    writeFileSync(join(root,'in.flac'),bytes);rmSync(join(root,'out'),{force:true});
    const args=[...row.args];args.splice(args.length-1,0,'-c:a','copy',alias,codec,...(index===2?['-aframes','99']:[]));
    verify(root,row,args);
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 },60000);
}
for(const [format,alias,limit] of [['wav','-frames:a','1'],['s16le','-aframes','2'],['framecrc','-frames:a','2']] as const){
 it(`launches unknown-total ${format} with positive ${alias} ${limit} against Native`,()=>{
  const root=mkdtempSync(join(tmpdir(),'edge-flac-prepass-expanded-')),row=rowIn(prepass,`1000/unknown/${format}/${alias}/${limit}`);
  try{writeFileSync(join(root,'in.flac'),Buffer.from(row.input,'base64'));verify(root,row,row.args);}finally{rmSync(root,{recursive:true,force:true});}
 },30000);
}
for(const format of ['aiff','au'])it(`keeps existing ${format} output atomic on module and malformed-input failures`,()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-flac-expanded-rollback-')),row=rowIn(output,`32-2-extremes-5/${format}`),sentinel=Buffer.from(`previous ${format} publication`),bytes=Buffer.from(row.input,'base64');
 try{
  writeFileSync(join(root,'in.flac'),bytes);writeFileSync(join(root,'out'),sentinel);
  const args=['-y',...row.args],missing=launch(root,args,[]);
  expect(missing.status).toBe(1);expect(missing.stderr).toMatch(/FLAC codec module is not configured/);expect(readFileSync(join(root,'out')).equals(sentinel)).toBe(true);
  const wrong=join(root,'wrong.wasm');writeFileSync(wrong,Buffer.from([0,97,115,109,1,0,0,0]));
  const rejected=launch(root,args,['--flac-wasm',wrong]);expect(rejected.status).toBe(1);expect(rejected.stderr).toMatch(/FLAC module differs/);expect(readFileSync(join(root,'out')).equals(sentinel)).toBe(true);
  // Local rollback policy only: no claim that malformed decode matches Native.
  writeFileSync(join(root,'in.flac'),bytes.subarray(0,bytes.length-5));
  const malformed=launch(root,args);expect(malformed.status,malformed.stderr).toBe(1);
  const summary=JSON.parse(malformed.stderr) as {outputs:string[]};expect(summary.outputs).toEqual([]);
  expect(sha(readFileSync(join(root,'out')))).toBe(sha(sentinel));expect(readdirSync(root).sort()).toEqual(['in.flac','out','wrong.wasm']);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
