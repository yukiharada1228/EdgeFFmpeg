import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
it('matches 120 cached Native frame FIFO traces through the public queue API in local workerd',async()=>{
 const root='compat/behavior-specs/thread-frame-queue',cases=JSON.parse(readFileSync(root+'/cases.json','utf8')),native=JSON.parse(readFileSync(root+'/results.json','utf8'));
 const bundle=await build({entryPoints:['tests/workers/thread-frame-queue-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'}),config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:config.compatibility_date}));
 try{await mf.ready;expect(cases).toHaveLength(120);for(let offset=0;offset<cases.length;offset+=8){const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify(cases.slice(offset,offset+8))});expect(response.status).toBe(200);expect(await response.json()).toEqual(native.slice(offset,offset+8));}}finally{await mf.dispose();}
},30000);
