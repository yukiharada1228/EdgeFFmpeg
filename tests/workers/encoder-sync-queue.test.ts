import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
it('matches 110 complete cached Native video encoder synchronization trace digests in local workerd',async()=>{
 const root='compat/behavior-specs/video-encoder-sync',cases=JSON.parse(readFileSync(root+'/cases.json','utf8')),digests=JSON.parse(readFileSync(root+'/trace-sha256.json','utf8'));
 const bundle=await build({entryPoints:['tests/workers/encoder-sync-queue-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'}),config=JSON.parse(readFileSync('wrangler.jsonc','utf8')),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:config.compatibility_date}));
 try{await mf.ready;expect((await mf.dispatchFetch('https://test/',{method:'POST',body:'x'.repeat(256*1024+1)})).status).toBe(413);expect((await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify([{limiting:[true],bufferUs:'0',ops:[[false]]}])})).status).toBe(400);expect(cases).toHaveLength(110);for(let offset=0;offset<cases.length;offset+=4){const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify(cases.slice(offset,offset+4))});expect(response.status).toBe(200);expect(await response.json()).toEqual(digests.slice(offset,offset+4));}}finally{await mf.dispose();}
},30000);
