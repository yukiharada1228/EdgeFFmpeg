import {it,expect} from 'vitest';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {verifiedDefaultLayoutCases} from '../helpers/default-channel-layout.js';
it('matches all 512 fixed Native default-layout cases inside workerd with bounded I/O and committed outputs',async()=>{
 const rows=verifiedDefaultLayoutCases(),bundle=await build({entryPoints:['tests/workers/default-channel-layout-fixture.ts'],bundle:true,platform:'browser',format:'esm',write:false}),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19'}));
 const failures:unknown[]=[];try{await mf.ready;for(const[index,row]of rows.entries()){try{
  const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({input:Array.from(Buffer.from(row.input,'base64')),argv:row.argv})});expect(response.status).toBe(200);
  const actual=await response.json() as {exitCode:number;outputs:string[];diagnostics:unknown[];data:number[];committed:boolean;aborted:boolean;maximumRead:number;maximumWrite:number};
  expect(actual.exitCode).toBe(row.exitCode);expect(actual.outputs).toEqual(['/output']);expect(actual.diagnostics).toEqual([]);expect(Buffer.from(actual.data)).toEqual(Buffer.from(row.output,'base64'));expect(actual.committed).toBe(true);expect(actual.aborted).toBe(false);expect(actual.maximumRead).toBeLessThanOrEqual(64);expect(actual.maximumWrite).toBeLessThanOrEqual(64);
 }catch(error){failures.push({index,argv:row.argv,error:String(error)});}}expect(failures).toEqual([]);}finally{await mf.dispose();}
},30000);
