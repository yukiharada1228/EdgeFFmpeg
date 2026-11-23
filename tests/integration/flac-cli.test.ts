import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
import corpus from '../../compat/behavior-specs/flac-cli/cases.json' with {type:'json'};
it('copies FLAC through the actual launcher with pinned Native framecrc and transactional overwrite',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-flac-cli-'));
 try{writeFileSync(join(root,'input.bin'),Buffer.from(corpus.input,'base64'));
 for(const row of corpus.rows){
 rmSync(join(root,'output.crc'),{force:true});
 const result=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--',...row.args],{encoding:'utf8',timeout:10000});
 expect(result.status,row.id+result.stderr).toBe(0);expect(JSON.parse(result.stdout).outputs).toEqual(['/output.crc']);expect(readFileSync(join(root,'output.crc'),'utf8')).toBe(row.stdout);
 const denied=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--','-n',...row.args],{encoding:'utf8',timeout:10000});expect(denied.status).toBe(0);expect(JSON.parse(denied.stdout).diagnostics[0].code).toBe('output-exists');expect(readFileSync(join(root,'output.crc'),'utf8')).toBe(row.stdout);
 const replaced=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,'--','-y',...row.args],{encoding:'utf8',timeout:10000});expect(replaced.status,replaced.stderr).toBe(0);expect(readdirSync(root).sort()).toEqual(['input.bin','output.crc']);
 }
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
it('production FLAC copy graph bundles without Node or native imports',async()=>{
 const {build}=await import('esbuild');const result=await build({entryPoints:['packages/avformat/src/flac-copy.ts'],bundle:true,write:false,platform:'browser',format:'esm',metafile:true});
 expect(Object.keys(result.metafile!.inputs).some(path=>path.includes('.build/')||path.includes('runtime-node'))).toBe(false);expect(result.outputFiles[0]!.text).not.toMatch(/node:|child_process|\.build\//);
});
