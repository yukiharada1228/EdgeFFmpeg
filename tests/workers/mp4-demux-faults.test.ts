import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
it('detects replaced, same-content regenerated and deleted R2 input before yielding payloads',async()=>{
 const bundle=await build({entryPoints:['tests/workers/mp4-demux-fixture.ts'],tsconfig:'tsconfig.json',bundle:true,write:false,format:'esm',platform:'browser'}),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19',r2Buckets:['BUCKET']}));
 try{await mf.ready;const bucket=await mf.getR2Bucket('BUCKET'),inputs=JSON.parse(readFileSync(new URL('../../compat/behavior-specs/mp4-demux/inputs.json',import.meta.url),'utf8')) as {id:string;input:string}[],bytes=Array.from(Buffer.from(inputs.find(row=>row.id==='variant-0')!.input,'base64'));
  for(const fault of ['replace','same-content','delete']){const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({bytes,fault})});expect(response.status,fault).toBe(409);const body=await response.json() as {error:string;packets?:unknown};expect(body.error,fault).toMatch(/Input (generation )?changed while reading/);expect(body.packets).toBeUndefined();expect((await bucket.list()).objects).toHaveLength(0);}
  for(const body of ['{',JSON.stringify({bytes:[-1]}),JSON.stringify({bytes:[0.5]}),JSON.stringify({bytes:new Array(16385).fill(0)}),JSON.stringify({bytes,fault:'unknown'})]){const response=await mf.dispatchFetch('https://test/',{method:'POST',body});expect(response.status).toBe(400);expect((await bucket.list()).objects).toHaveLength(0);}
  const large=await mf.dispatchFetch('https://test/',{method:'POST',body:'x'.repeat(65537)});expect(large.status).toBe(413);expect((await bucket.list()).objects).toHaveLength(0);
 }finally{await mf.dispose();}
},30000);
