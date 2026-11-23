import {it,expect} from 'vitest';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {loadH264Corpus,loadH264Module} from '../helpers/h264-corpus.js';
it('matches Native H264 POC and MMCO5 corpus in bounded workerd Wasm',async()=>{
 const rows=loadH264Corpus(),wasm=loadH264Module(),root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/h264-fixture.ts'],bundle:true,metafile:true,write:false,format:'esm',platform:'browser',external:['./openh264.wasm']});
 expect(Object.keys(bundle.metafile.inputs).some(p=>p.startsWith('.build/'))).toBe(false);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/h264-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/openh264.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-19'}));
 try{await mf.ready;for(const row of rows){const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify(row)});expect(response.status,row.id).toBe(200);expect(await response.json(),row.id).toEqual({frames:row.expected,resetTokens:row.resetTokens,memoryBytes:0,queuedBytes:0,pendingPackets:0,closed:true});}}finally{await mf.dispose();}
},30000);
