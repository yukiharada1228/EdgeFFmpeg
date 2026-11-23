import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
it('matches 14401 cached Native double-to-rational results in local workerd',async()=>{
 const root='compat/behavior-specs/number-rational',cases=JSON.parse(readFileSync(root+'/cases.json','utf8')),results=JSON.parse(readFileSync(root+'/results.json','utf8'));
 const bundle=await build({entryPoints:['tests/workers/number-rational-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'}),config=JSON.parse(readFileSync('wrangler.jsonc','utf8')),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:config.compatibility_date}));
 try{await mf.ready;expect((await mf.dispatchFetch('https://test/',{method:'POST',body:'x'.repeat(64*1024+1)})).status).toBe(413);expect((await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify([{bits:'0000000000000000',max:0}])})).status).toBe(400);expect(cases).toHaveLength(14401);for(let offset=0;offset<cases.length;offset+=128){const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify(cases.slice(offset,offset+128))});expect(response.status).toBe(200);expect(await response.json()).toEqual(results.slice(offset,offset+128));}}finally{await mf.dispose();}
},30000);
