import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import type {SimpleVideoCase} from '../helpers/simple-video-cli.js';
const groups=[{family:'option-order',count:2086,name:'matches 2086 Native video option-order jobs through public R2 on both backend factories'},{family:'rate-clocks',count:800,name:'matches 800 Native independent-clock jobs through public R2'}];
for(const group of groups)it(group.name,async()=>{
 const root='compat/behavior-specs/video-option-order',cases=JSON.parse(readFileSync(root+'/cases.json','utf8')) as (SimpleVideoCase&{family:string})[],results=JSON.parse(readFileSync(root+'/results.json','utf8')) as {exitCode:number;rows:Record<string,string>}[],provenance=JSON.parse(readFileSync(root+'/provenance.json','utf8')) as {numericProfile:string};
 const bundle=await build({entryPoints:['tests/workers/simple-video-cli-fixture.ts'],bundle:true,metafile:true,write:false,format:'esm',platform:'browser',target:'es2022'});expect(Object.keys(bundle.metafile.inputs).filter(path=>path.startsWith('.build/'))).toEqual([]);
 const config=JSON.parse(readFileSync('wrangler.jsonc','utf8')),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:config.compatibility_date,r2Buckets:['BUCKET']}));try{await mf.ready;expect((await mf.dispatchFetch('https://test/',{method:'POST',body:'x'.repeat(64*1024+1)})).status).toBe(413);expect((await mf.dispatchFetch('https://test/',{method:'POST',body:'{}'})).status).toBe(400);expect(cases).toHaveLength(2886);expect(results).toHaveLength(cases.length);const selected=cases.map((row,index)=>({row,index})).filter(({row})=>row.family===group.family);expect(selected).toHaveLength(group.count);
  for(const {row,index}of selected){const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({row,profile:provenance.numericProfile})});expect(response.status,row.id).toBe(200);const actual=await response.json() as {exitCode:number;outputs:string[];rows:Record<string,string>;reads:Record<string,number>;temporary:number};expect(actual.exitCode,row.id).toBe(results[index]!.exitCode);expect(actual.rows,row.id).toEqual(results[index]!.rows);expect(actual.outputs,row.id).toEqual(Object.keys(results[index]!.rows));expect(actual.temporary,row.id).toBe(0);expect(Object.values(actual.reads).every(count=>count===1),row.id).toBe(true);if(actual.exitCode!==0)expect(actual.reads).toEqual({});}
 }finally{await mf.dispose();}
},60000);
