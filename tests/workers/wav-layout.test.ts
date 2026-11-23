import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
it('matches all 86 Native WAV mask and layout cases inside workerd with bounded I/O',async()=>{
 const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const rows:{input:string;output:string;guess?:boolean;exitCode:number}[]=[];
 for(const group of ['wav-channel-mask','wav-channel-layout']){
  const base='compat/behavior-specs/'+group+'/',manifest=JSON.parse(readFileSync(base+'manifest.json','utf8')) as {sha256:Record<string,string>};
  for(const [name,digest] of Object.entries(manifest.sha256))expect(hash(readFileSync(base+name))).toBe(digest);
  const provenance=JSON.parse(readFileSync(base+'provenance.json','utf8')) as {sources:Record<string,string>;reference:{artifacts:Record<string,string>}};
  for(const [name,digest] of Object.entries(provenance.sources))expect(hash(readFileSync(name))).toBe(digest);
  for(const name of ['ffmpeg','ffprobe'])expect(hash(readFileSync('.build/reference/'+name))).toBe(provenance.reference.artifacts[name]);
  rows.push(...JSON.parse(readFileSync(base+'cases.json','utf8')).rows);
 }
 expect(rows).toHaveLength(86);
 const bundle=await build({entryPoints:['tests/workers/wav-layout-fixture.ts'],bundle:true,platform:'browser',format:'esm',write:false}),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19'}));
 try{await mf.ready;for(const row of rows){
  const response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({input:Array.from(Buffer.from(row.input,'base64')),guess:row.guess??true})});expect(response.status).toBe(200);
  const actual=await response.json() as {exitCode:number;outputs:string[];diagnostics:unknown[];data:number[];committed:boolean;aborted:boolean;maximumRead:number;maximumWrite:number};
  expect(actual.exitCode).toBe(row.exitCode);expect(actual.outputs).toEqual(['/output.wav']);expect(actual.diagnostics).toEqual([]);
  expect(Buffer.from(actual.data)).toEqual(Buffer.from(row.output,'base64'));expect(actual.committed).toBe(true);expect(actual.aborted).toBe(false);expect(actual.maximumRead).toBeLessThanOrEqual(64);expect(actual.maximumWrite).toBeLessThanOrEqual(64);
 }}finally{await mf.dispose();}
},30000);
