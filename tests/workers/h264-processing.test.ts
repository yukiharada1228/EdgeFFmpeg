import {it,expect} from 'vitest';
import {resolve,join} from 'node:path';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {loadH264Module,h264Hash} from '../helpers/h264-corpus.js';
interface Result {exitCode:number;bytes:number;sha256:string;temporary:number;multipartLive:number;aborts:number;diagnostics:{code:string}[]}
it('runs H264 spatial processing in workerd with R2 rollback on processing exhaustion and cancellation',async()=>{
 const corpus=loadH264Mp4Corpus(),root=resolve('tests/workers'),directory=mkdtempSync(join(tmpdir(),'edge-h264-processing-r2-')),bundle=await build({entryPoints:[root+'/h264-mp4-fixture.mjs'],bundle:true,metafile:true,write:false,format:'esm',platform:'browser',external:['./openh264.wasm']});
 expect(Object.keys(bundle.metafile.inputs).some(path=>path.startsWith('.build/'))).toBe(false);verifyH264Reference();
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/h264-processing-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/openh264.wasm',contents:loadH264Module()}],modulesRoot:root,compatibilityDate:'2026-11-19',r2Buckets:['BUCKET']}));
 const execute=async(input:string,row:Record<string,unknown>)=>{const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({input,limit:4,...row})});expect(response.status).toBe(200);return await response.json() as Result;};let checked=0;
 try{await mf.ready;
  for(const id of ['moving-main-cavlc-spatial-none','moving-high-cabac-temporal-normal','hd-main-cavlc-spatial-none','hd-high-cabac-temporal-normal']){
   const input=corpus.inputs.find(row=>row.id===id)!;writeFileSync(join(directory,'input.mp4'),Buffer.from(input.data,'base64'));
   for(const scalar of [false,true])for(const processing of id.startsWith('hd-')?[['-vf','scale=48:32']]:[['-vf','hflip'],['-vf','transpose=1'],['-pix_fmt','rgb24'],['-vf','hflip,scale=48:32','-pix_fmt','nv12']]){
    const native=spawnSync('.build/reference/ffmpeg',['-v','error','-y',...(scalar?['-cpuflags','0']:[]),'-f','mp4','-i',join(directory,'input.mp4'),'-map','0:v:0','-an','-c:v','rawvideo','-pix_fmt','yuv420p','-fps_mode','passthrough',...processing,'-frames:v','4','-f','rawvideo',join(directory,'native.raw')],{encoding:'utf8',timeout:15000});expect(native.status,id+native.stderr).toBe(0);
    const expected=readFileSync(join(directory,'native.raw')),actual=await execute(input.data,{scalar,processing});expect(actual.exitCode,id+JSON.stringify(actual.diagnostics)).toBe(0);expect(actual.bytes,id).toBe(expected.length);expect(actual.sha256,id).toBe(h264Hash(expected));expect([actual.temporary,actual.multipartLive]).toEqual([0,0]);checked++;
   }
  }expect(checked).toBe(20);
  const input=corpus.inputs.find(row=>row.id==='moving-high-cabac-temporal-normal')!;
  for(const row of [{maxProcessingBytes:1},{maxProcessingBytes:134217728},{mode:'processing-cancel'}]){
   const result=await execute(input.data,{preexisting:true,overwrite:true,processing:['-vf','hflip'],...row});expect(result.exitCode).toBe(1);expect(result.sha256).toBe(h264Hash('previous-output-sentinel'));expect([result.temporary,result.multipartLive]).toEqual([0,0]);if(!row.mode)expect(result.diagnostics[0]?.code).toBe('resource-budget');else expect(result.aborts).toBe(1);
  }
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},300000);
