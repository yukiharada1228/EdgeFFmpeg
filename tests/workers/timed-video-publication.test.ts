import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {evaluatePublication} from '../helpers/timed-video-publication.js';
it('preserves eleven public timed backend publication and cleanup outcomes in local workerd',async()=>{
 const bundle=await build({entryPoints:['tests/workers/timed-video-publication-fixture.ts'],bundle:true,metafile:true,write:false,format:'esm',platform:'browser',target:'es2022'});expect(Object.keys(bundle.metafile.inputs).filter(path=>path.startsWith('.build/'))).toEqual([]);
 const config=JSON.parse(readFileSync('wrangler.jsonc','utf8')),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:config.compatibility_date}));try{await mf.ready;expect((await mf.dispatchFetch('https://test/',{method:'POST',body:'x'.repeat(257)})).status).toBe(413);expect((await mf.dispatchFetch('https://test/',{method:'POST',body:'{}'})).status).toBe(400);for(const scenario of ['ok','read-error','cancel-read','open-output-error','write-error','commit-error','ack-lost','uncertain-ack','cancel-after-left','store-close-error','abort-error']){const expected=await evaluatePublication(scenario),response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify(scenario)});expect(response.status).toBe(200);expect(await response.json(),scenario).toEqual(expected);}}finally{await mf.dispose();}
},30000);
