import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
interface Row {id:string;input:string;inputSha256:string;expected:{sampleRate:number;channels:number;bitsPerSample:number;totalSamples:number|null;timeBase:string}}
interface Result {owned:number;peak:number;reads:number;maximumRead:number;error?:string;cancelReasonPreserved?:boolean;result?:{kind:string;framesOffset:string|null;directoryComplete:boolean;metadataValidationComplete:boolean;streamInfo:{sampleRate:number;channels:number;bitsPerSample:number;totalSamples:string;totalSamplesKnown:boolean;timeBase:{num:string;den:string}}}}
it('matches 18 Native clean metadata inputs on actual R2/workerd with short reads and cancellation cleanup',async()=>{
 const base=new URL('../../compat/behavior-specs/flac-metadata/',import.meta.url),raw=readFileSync(new URL('cases.json',base)),manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8')) as {casesSha256:string};
 const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');expect(sha(raw)).toBe(manifest.casesSha256);
 const corpus=JSON.parse(raw.toString()) as {rows:Row[]};expect(corpus.rows).toHaveLength(18);
 const bundle=await build({entryPoints:['tests/workers/flac-metadata-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports).toEqual([]);
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const row of corpus.rows){const input=Buffer.from(row.input,'base64');expect(sha(input)).toBe(row.inputSha256);await bucket.put('source/input.flac',input);
   for(const cap of [1,34]){
    const response=await mf.dispatchFetch('https://metadata.test/?cap='+cap);expect(response.status,row.id).toBe(200);const actual=await response.json() as Result;
    expect(actual.owned).toBe(0);expect(actual.peak).toBeLessThanOrEqual(34);expect(actual.maximumRead).toBeLessThanOrEqual(cap);expect(actual.reads).toBeGreaterThan(0);
    expect(actual.result?.kind).toBe('flac-streaminfo');expect(actual.result?.directoryComplete).toBe(true);expect(actual.result?.framesOffset).not.toBeNull();expect(actual.result?.metadataValidationComplete).toBe(false);
    const info=actual.result?.streamInfo;if(!info)throw Error('Missing STREAMINFO');
    expect({sampleRate:info.sampleRate,channels:info.channels,bitsPerSample:info.bitsPerSample,totalSamples:info.totalSamplesKnown?Number(info.totalSamples):null,timeBase:`${info.timeBase.num}/${info.timeBase.den}`},row.id).toEqual(row.expected);
   }
  }
  for(const mode of ['read-abort','checkpoint-abort']){const response=await mf.dispatchFetch('https://metadata.test/?mode='+mode);expect(response.status).toBe(422);const actual=await response.json() as Result;expect(actual.error).toBe('metadata fixture cancelled');expect(actual.cancelReasonPreserved).toBe(true);expect(actual.owned).toBe(0);expect(actual.peak).toBeLessThanOrEqual(34);}
 }finally{if(bucket){await bucket.delete('source/input.flac');expect((await bucket.list()).objects).toEqual([]);}await mf.dispose();}
},30000);
