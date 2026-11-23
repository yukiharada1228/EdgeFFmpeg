import {overwriteConflictCases} from '../helpers/mp4-overwrite-conflict.js';
import {it,expect} from 'vitest';
import {selectedErrorCopyJobs} from '../helpers/mp4-selected-errors.js';
import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
it('rejects conflicting MP4 overwrite flags with Native status in workerd before output writes',async()=>{
 verifyH264Reference();const fixed=overwriteConflictCases();const bundle=await build({entryPoints:['tests/workers/mp4-zero-copy-fixture.ts'],bundle:true,platform:'browser',format:'esm',write:false}),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19',r2Buckets:['BUCKET']}));let cases=0;
 try{await mf.ready;for(const row of selectedErrorCopyJobs().filter(row=>['first','later','both'].includes(row.selection)))for(const flags of [['-y','-n'],['-n','-y']]){
  const expected=fixed.find(item=>item.inputId===row.inputId&&item.map===row.options[1]&&JSON.stringify(item.flags)===JSON.stringify(flags)&&!item.existing);expect(expected,row.id).toBeDefined();
  const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({bytes:Array.from(Buffer.from(row.input,'base64')),options:[...flags,...row.options,'-c:a','copy']})});expect(response.status).toBe(200);const actual=await response.json() as {exitCode:number;outputs:string[];data:string|null;writes:number;temporary:number;diagnostics:unknown};
  expect(actual.exitCode,row.id).toBe(expected!.exitCode);expect(actual.diagnostics).toEqual([{code:'invalid-arguments',message:'Error, both -y and -n supplied. Exiting.'}]);expect(actual.outputs).toEqual([]);expect(actual.data).toBeNull();expect(actual.writes).toBe(0);expect(actual.temporary).toBe(0);expect((await(await mf.getR2Bucket('BUCKET')).list()).objects).toHaveLength(0);cases++;
 }expect(cases).toBe(54);}finally{await mf.dispose();}verifyH264Reference();
},360000);
