import {overwriteConflictCases} from '../helpers/mp4-overwrite-conflict.js';
import {it,expect} from 'vitest';
import {selectedErrorCopyJobs} from '../helpers/mp4-selected-errors.js';
import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {writeFileSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
it('matches Native conflicting overwrite flag status before selected audio header failure',()=>{
 verifyH264Reference();const fixed=overwriteConflictCases();const directory=mkdtempSync(join(tmpdir(),'edge-overwrite-conflict-')),sentinel=Buffer.from([17,31,43]);let cases=0;
 try{for(const row of selectedErrorCopyJobs().filter(row=>['first','later','both'].includes(row.selection)))for(const flags of [['-y','-n'],['-n','-y']])for(const existing of [false,true]){
  const expected=fixed.find(item=>item.inputId===row.inputId&&item.map===row.options[1]&&JSON.stringify(item.flags)===JSON.stringify(flags)&&item.existing===existing);expect(expected,row.id).toBeDefined();
  const input=join(directory,'input.mp4'),nativeOutput=join(directory,'native.mp4'),actualOutput=join(directory,'actual.mp4');writeFileSync(input,Buffer.from(row.input,'base64'));
  for(const file of [nativeOutput,actualOutput]){rmSync(file,{force:true});if(existing)writeFileSync(file,sentinel);}
  const native=spawnSync('.build/reference/ffmpeg',['-v','error',...flags,'-i',input,...row.options,'-c:a','copy','-f','mp4',nativeOutput],{encoding:'utf8',timeout:15000,input:''});
  expect(native.signal,row.id).toBeNull();expect(native.status,row.id+native.stderr).toBe(expected!.exitCode);expect(native.stderr).toContain('both -y and -n supplied');
  const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--',...flags,'-i','/input.mp4',...row.options,'-c:a','copy','-f','mp4','/actual.mp4'],{encoding:'utf8',timeout:15000,input:''});
  expect(actual.signal,row.id).toBeNull();expect(actual.status,row.id+actual.stderr).toBe(native.status);expect(JSON.parse(actual.stderr.trim().split('\n').at(-1)!).diagnostics).toEqual([{code:'invalid-arguments',message:'Error, both -y and -n supplied. Exiting.'}]);
  if(existing){expect(readFileSync(actualOutput)).toEqual(sentinel);expect(readFileSync(nativeOutput)).toEqual(sentinel);}else{expect(()=>readFileSync(actualOutput)).toThrow();expect(()=>readFileSync(nativeOutput)).toThrow();}cases++;
 }expect(cases).toBe(108);}finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},360000);
