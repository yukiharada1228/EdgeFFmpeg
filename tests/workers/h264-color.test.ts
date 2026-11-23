import {it,expect} from 'vitest';
import {resolve,join} from 'node:path';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {loadH264Module,h264Hash} from '../helpers/h264-corpus.js';
it('matches native H264 VUI color matrices through bounded workerd RGB conversion and scaling',async()=>{
 verifyH264Reference();const corpus=loadH264Mp4Corpus(),root=resolve('tests/workers'),directory=mkdtempSync(join(tmpdir(),'edge-h264-color-')),bundle=await build({entryPoints:[root+'/h264-mp4-fixture.mjs'],bundle:true,metafile:true,write:false,format:'esm',platform:'browser',external:['./openh264.wasm']});expect(Object.keys(bundle.metafile.inputs).some(path=>path.startsWith('.build/'))).toBe(false);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/h264-color-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/openh264.wasm',contents:loadH264Module()}],modulesRoot:root,compatibilityDate:'2026-11-19',r2Buckets:['BUCKET']}));let checked=0;
 try{await mf.ready;
  for(const id of ['moving-main-cavlc-spatial-none','moving-high-cabac-temporal-normal','hd-high-cabac-temporal-normal']){
   writeFileSync(join(directory,'source.mp4'),Buffer.from(corpus.inputs.find(row=>row.id===id)!.data,'base64'));
   for(const matrix of [1,4,7,9]){
    const patch=spawnSync('.build/reference/ffmpeg',['-v','error','-y','-i',join(directory,'source.mp4'),'-map','0:v:0','-c:v','copy','-bsf:v',`h264_metadata=matrix_coefficients=${matrix}`,'-f','mp4',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(patch.status,patch.stderr).toBe(0);
    const input=readFileSync(join(directory,'input.mp4')).toString('base64');
    for(const scalar of [false,true])for(const processing of id.startsWith('hd-')?[['-vf','scale=48:32','-pix_fmt','rgb24']]:[['-pix_fmt','rgb24'],['-pix_fmt','bgra'],['-pix_fmt','gbrp'],['-vf','scale=48:32','-pix_fmt','rgb24']]){
     const native=spawnSync('.build/reference/ffmpeg',['-v','error','-y',...(scalar?['-cpuflags','0']:[]),'-f','mp4','-i',join(directory,'input.mp4'),'-map','0:v:0','-an','-c:v','rawvideo','-fps_mode','passthrough',...processing,'-frames:v','4','-f','rawvideo',join(directory,'native.raw')],{encoding:'utf8',timeout:15000});expect(native.status,native.stderr).toBe(0);
     const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({input,limit:4,scalar,processing})});expect(response.status).toBe(200);const actual=await response.json() as {exitCode:number;bytes:number;sha256:string;diagnostics:unknown;temporary:number;multipartLive:number},expected=readFileSync(join(directory,'native.raw'));
     expect(actual.exitCode,`${id}/${matrix}/${processing}: `+JSON.stringify(actual.diagnostics)).toBe(0);expect(actual.bytes).toBe(expected.length);expect(actual.sha256,`${id}/${matrix}/${processing}/${scalar}`).toBe(h264Hash(expected));expect([actual.temporary,actual.multipartLive]).toEqual([0,0]);checked++;
    }
   }
  }expect(checked).toBe(72);
 }finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},300000);
