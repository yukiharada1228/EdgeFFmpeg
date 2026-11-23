import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {TimedVideoCase} from '../helpers/timed-video-backend.js';
it('matches 1134 pinned Native crop and scale CLI outputs through public packages and local R2',async()=>{
 const root='compat/behavior-specs/timed-video-backend',cases=JSON.parse(readFileSync(root+'/cases.json','utf8')) as TimedVideoCase[],results=JSON.parse(readFileSync(root+'/results.json','utf8')) as string[],provenance=JSON.parse(readFileSync(root+'/provenance.json','utf8')) as {numericProfile:string};
 const bundle=await build({entryPoints:['tests/workers/timed-video-backend-fixture.ts'],bundle:true,metafile:true,write:false,format:'esm',platform:'browser',target:'es2022'});expect(Object.keys(bundle.metafile.inputs).filter(path=>path.startsWith('.build/'))).toEqual([]);
 const config=JSON.parse(readFileSync('wrangler.jsonc','utf8')),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:config.compatibility_date,r2Buckets:['BUCKET']}));try{await mf.ready;expect((await mf.dispatchFetch('https://test/',{method:'POST',body:'x'.repeat(64*1024+1)})).status).toBe(413);expect((await mf.dispatchFetch('https://test/',{method:'POST',body:'{}'})).status).toBe(400);expect(cases).toHaveLength(1134);expect(results).toHaveLength(cases.length);for(const [index,row]of cases.entries()){const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({row,profile:provenance.numericProfile})});expect(response.status,JSON.stringify(row)).toBe(200);expect(await response.json(),JSON.stringify(row)).toEqual({exitCode:0,outputs:['/output/out'],diagnostics:[],text:results[index],temporary:0});}}finally{await mf.dispose();}
},60000);
