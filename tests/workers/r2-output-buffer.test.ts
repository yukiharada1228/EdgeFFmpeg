import {beforeAll,afterAll,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
let mf:Miniflare;
beforeAll(async()=>{
 const bundle=await build({entryPoints:['tests/workers/r2-output-buffer-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});
 expect(Object.keys(bundle.metafile.inputs).some(file=>file.startsWith('.build/'))).toBe(false);for(const output of Object.values(bundle.metafile.outputs))expect(output.imports).toEqual([]);
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['BUCKET']}));await mf.ready;
});
afterAll(async()=>{await mf?.dispose();});
for(const[kind,size]of [['budget',513],['small',257],['growth',8193],['multipart',5*1024*1024+17]] as const)it(`preserves ${kind} R2 output bytes and multipart boundaries within staging bounds`,async()=>{
 const response=await mf.dispatchFetch('https://buffer.test/'+kind);expect(response.status).toBe(200);const actual=await response.json() as {kind:string;bytes:number;digest:string;publishedBeforeCommit:boolean;temporary:number;parts:{number:number;bytes:number;backingBytes:number}[]},expected=Buffer.from(Uint8Array.from({length:size},(_,i)=>(i*17+3)&255));
 expect(actual.kind).toBe(kind);expect(actual.bytes).toBe(size);expect(actual.digest).toBe(createHash('sha256').update(expected).digest('hex'));expect(actual.publishedBeforeCommit).toBe(false);expect(actual.temporary).toBe(0);
 expect(actual.parts.map(part=>part.bytes)).toEqual(kind==='multipart'?[5*1024*1024,17]:[size]);expect(actual.parts.every(part=>part.backingBytes<=5*1024*1024)).toBe(true);
 if(kind==='budget')expect(actual.parts[0]!.backingBytes).toBeLessThanOrEqual(1024);if(kind==='small')expect(actual.parts[0]!.backingBytes).toBeLessThanOrEqual(65536);
});
