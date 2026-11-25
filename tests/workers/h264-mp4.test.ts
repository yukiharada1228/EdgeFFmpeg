import {it,expect} from 'vitest';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {loadH264Mp4Corpus} from '../helpers/h264-mp4-corpus.js';
import {loadH264Module,h264Hash} from '../helpers/h264-corpus.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
// The fixture converts with the reference build's default pixel profile (x86_64 for the linux-x64 pin), resolved once.
let pixelProfile:ReturnType<typeof referencePixelArithmetic>|undefined;const pixelArithmetic=()=>pixelProfile??=referencePixelArithmetic();
interface Output {errorResource:string|null;effectStatuses:string[];exitCode:number;outputs:string[];bytes:number|null;sha256:string|null;reads:number;writes:number;opens:number;aborts:number;temporary:number;changed:boolean;multipartCreated:number;multipartParts:number;multipartCompleted:number;multipartAborted:number;multipartLive:number;diagnostics:{code:string;message:string}[]}
it('matches Native MP4 H264 frames in R2 and preserves outputs across decode and resource failures',async()=>{
 const corpus=loadH264Mp4Corpus(),root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/h264-mp4-fixture.mjs'],bundle:true,metafile:true,write:false,format:'esm',platform:'browser',external:['./openh264.wasm']});expect(Object.keys(bundle.metafile.inputs).some(path=>path.startsWith('.build/'))).toBe(false);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/h264-mp4-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/openh264.wasm',contents:loadH264Module()}],modulesRoot:root,compatibilityDate:'2026-11-19',r2Buckets:['BUCKET']}));
 const execute=async(row:Record<string,unknown>,inputId:string)=>{const input=corpus.inputs.find(input=>input.id===inputId)!;const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({...row,input:input.data,pixelArithmetic:pixelArithmetic()})});expect(response.status,inputId).toBe(200);return await response.json() as Output;};
 const evidence:{name:string;code:string|null;resource:string|null;effects:string[];staging:number;uploads:number}[]=[];
 try{await mf.ready;
  for(const row of corpus.cases){const actual=await execute({limit:row.limit,options:row.map},row.inputId);expect(actual.exitCode,row.id+JSON.stringify(actual.diagnostics)).toBe(0);expect(actual.bytes,row.id).toBe(row.expectedBytes);expect(actual.sha256,row.id).toBe(row.expectedSha256);expect(actual.outputs).toHaveLength(1);expect(actual.opens).toBe(1);expect(actual.aborts).toBe(0);expect([actual.temporary,actual.multipartLive]).toEqual([0,0]);}
  for(const row of corpus.faults){const actual=await execute({...row},row.inputId),success=row.mode==='overwrite-success';expect(actual.exitCode,row.name).toBe(success?0:1);expect(actual.outputs,row.name).toHaveLength(success?1:0);expect([actual.temporary,actual.multipartLive],row.name).toEqual([0,0]);
   if(row.preexisting){expect(actual.bytes,row.name).toBe(success?row.expectedBytes:24);expect(actual.sha256,row.name).toBe(success?row.expectedSha256:h264Hash('previous-output-sentinel'));}else{expect(actual.bytes,row.name).toBeNull();expect(actual.aborts,row.name).toBe(actual.opens);}
   if(['frame-budget','nal-budget','pending-budget','display-budget','wasm-budget'].includes(row.mode))expect(actual.diagnostics[0]?.code,row.name).toBe('resource-budget');
   if(['early-avcc','late-nal','late-length','input-change','output-budget'].includes(row.mode))expect(actual.diagnostics[0]?.code,row.name).not.toBe('resource-budget');
   if(row.mode==='pending-cleanup'){expect(actual.diagnostics[0]?.code,row.name).toBe('output-publication-failed');expect(actual.effectStatuses).toEqual(['cleanup-failed']);expect(actual.errorResource).toBe('pending-packets');}
   const resources:Record<string,string>={'frame-budget':'frame-bytes','nal-budget':'nal-units','pending-budget':'pending-packets','display-budget':'display-bytes','wasm-budget':'wasm-memory'};if(resources[row.mode])expect(actual.errorResource,row.name).toBe(resources[row.mode]);evidence.push({name:row.name,code:actual.diagnostics[0]?.code??null,resource:actual.errorResource,effects:actual.effectStatuses,staging:actual.temporary,uploads:actual.multipartLive});
   if(row.mode==='input-change'){expect(actual.changed).toBe(true);expect(actual.writes).toBeGreaterThan(0);}
   if(row.mode.endsWith('late-nal')||row.mode==='late-length'){expect(actual.writes).toBeGreaterThan(0);expect(actual.aborts).toBe(1);}
   if(row.mode.startsWith('overwrite-hd')){expect(actual.multipartParts).toBeGreaterThan(0);expect(actual.multipartAborted).toBe(1);}
   if(['early-avcc','frame-budget','nal-budget'].includes(row.mode))expect(actual.opens).toBe(0);
  }
  writeFileSync('.build/h264-resource-r2-evidence.json',JSON.stringify({normalCases:corpus.cases.length,controls:evidence,passed:true},null,2)+'\n');
 }finally{await mf.dispose();}
},300000);
