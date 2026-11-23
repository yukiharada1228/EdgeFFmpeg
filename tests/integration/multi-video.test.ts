import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {cases} from '../workers/multi-video-cases.js';
it('matches native multi-input CLI anchors through the actual Node launcher and staged filesystem',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-multi-launcher-')),anchors=JSON.parse(readFileSync('compat/behavior-specs/multi-video-cli-worker.json','utf8')) as {cases:{id:string;left:number[];right:number[]}[]};
 try{for(const c of cases){const directory=join(root,c.id);mkdirSync(join(directory,'input'),{recursive:true});mkdirSync(join(directory,'output'));writeFileSync(join(directory,'input/a.raw'),Uint8Array.from(c.a));writeFileSync(join(directory,'input/b.raw'),Uint8Array.from(c.b));
 const result=JSON.parse(execFileSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',directory,'--',...c.argv],{encoding:'utf8',timeout:15000})),native=anchors.cases.find(row=>row.id===c.id)!;expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect([...readFileSync(join(directory,'output/left.raw'))],c.id).toEqual(native.left);expect([...readFileSync(join(directory,'output/right.raw'))],c.id).toEqual(native.right);expect(readdirSync(join(directory,'output')).sort()).toEqual(['left.raw','right.raw']);
 }}finally{rmSync(root,{recursive:true,force:true});}
},60000);
