import {it,expect} from 'vitest';import {build} from 'esbuild';import {readFileSync} from 'node:fs';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
it('preserves setpts print effects, command log levels and error identity in local workerd',async()=>{
 const bundle=await build({entryPoints:['tests/workers/setpts-effects-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'}),config=JSON.parse(readFileSync('wrangler.jsonc','utf8')),worker=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:config.compatibility_date}));
 try{await worker.ready;const entry=(value:number)=>({value,level:16,text:value.toFixed(6)+'\n'});expect(await(await worker.dispatchFetch('https://test/effects')).json()).toEqual({commands:[entry(1),entry(2)],prints:[entry(0),entry(1)],status:'eof',failure:{primary:true,effect:true,status:'error'}});}finally{await worker.dispose();}
},30000);
