import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import combined from '../../compat/behavior-specs/flac-max-combined/cases.json' with {type:'json'};
import scalar from '../../compat/behavior-specs/flac-max-combined/scalar.json' with {type:'json'};
import remux from '../../compat/behavior-specs/flac-max-remux/cases.json' with {type:'json'};
import policy from '../../compat/behavior-specs/flac-max-combined/remux-policy.json' with {type:'json'};
import arithmeticProfile from '../../compat/behavior-specs/flac-max-remix/arithmetic.json' with {type:'json'};

for(const [kind,row] of [
 ['scalar-volume-rate',scalar.rows.find(row=>row.id==='16-2-ramp-5/known/volume-resample/scalar')!],
 ['unknown-total-output-time',combined.rows.find(row=>row.id==='24-2-ramp-5/unknown/output-to')!],
 ['packet-copy-no-decoder',remux.rows.find(row=>row.id==='16-2-ramp-5/default')!],
 ['packet-copy-metadata-padding',policy.rows[0]!],
 ['fused-remix-float',arithmeticProfile.scalarCase]
] as const)it(`actual Node launcher matches Native FLAC ${kind}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-flac-max-public-'));
 try{
  writeFileSync(join(root,'in.flac'),Buffer.from(row.input,'base64'));
  const settings=kind.startsWith('packet-copy')?[]:['--flac-wasm',resolve('.build/codecs/flac/edge-flac.wasm')];
  const run=spawnSync(process.execPath,[resolve('tools/cli/run.mjs'),'--root',root,...settings,'--',...row.args],{encoding:'utf8',timeout:20000,maxBuffer:1048576,...(kind==='fused-remix-float'?{env:{...process.env,EDGEFFMPEG_REMIX_ARITHMETIC:'fused'}}:{})});
  expect(run.error).toBeUndefined();expect(run.signal).toBeNull();expect(run.status,run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({exitCode:0,outputs:['/out'],diagnostics:[]});
  const output=readFileSync(join(root,'out'));expect(createHash('sha256').update(output).digest('hex')).toBe(row.outputSha256);expect(output.toString('base64')).toBe(row.output);
  expect(readdirSync(root).sort()).toEqual(['in.flac','out']);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
