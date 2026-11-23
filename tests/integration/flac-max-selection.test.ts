import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';

interface NativeRow {id:string;input:string;inputSha256:string;args:string[];exitCode:number;output:string;outputSha256:string|null;selectedStreamIds:number[]}
const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-selection/cases.json','utf8')) as {reference:{commit:string};rows:NativeRow[]};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sentinel=new TextEncoder().encode('preexisting selection output');

it('pins all 60 independently saved Native inputs and successful outputs',()=>{
 expect(corpus.reference.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');
 expect(corpus.rows).toHaveLength(60);
 for(const row of corpus.rows){expect(sha(Buffer.from(row.input,'base64')),row.id).toBe(row.inputSha256);if(row.exitCode===0)expect(sha(Buffer.from(row.output,'base64')),row.id).toBe(row.outputSha256);}
});

for(const row of corpus.rows)it(`public Node Native selection or explicit picture-mux gap ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];
 let stored:Uint8Array=sentinel,opens=0,commits=0,aborts=0,reads=0,maxRead=0;
 const filesystem:VirtualFileSystem={async openRead(path){expect(path).toBe('/in.flac');return {size:BigInt(input.length),async readAt(offset,length){reads++;maxRead=Math.max(maxRead,length);return input.subarray(Number(offset),Number(offset)+Math.min(19,length));}};},async openWrite(path){expect(path).toBe('/out');opens++;return {async write(bytes){chunks.push(bytes.slice());},async commit(){stored=Buffer.concat(chunks);commits++;},async abort(){chunks.length=0;aborts++;}};}};
 const result=await new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000}}).exec(['-y',...row.args]);
 const pictureGap=row.exitCode===0&&row.selectedStreamIds.some(id=>id!==0);
 expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(pictureGap?1:row.exitCode);
 expect(reads).toBeGreaterThan(0);expect(maxRead).toBeLessThanOrEqual(65536);
 if(row.exitCode===0&&!pictureGap){expect(Buffer.from(stored).toString('base64')).toBe(row.output);expect(result.outputs).toEqual(['/out']);expect(opens).toBe(1);expect(commits).toBe(1);expect(aborts).toBe(0);}
 else{expect(result.diagnostics[0]?.code).toBe(pictureGap?'unsupported-command':'invalid-arguments');expect(result.outputs).toEqual([]);expect(stored).toEqual(sentinel);expect(opens).toBe(0);expect(commits).toBe(0);}
});

it('observes late read rejection after cancellation without opening or publishing an output',async()=>{
 const controller=new AbortController(),reason=Error('selection read cancelled');let opens=0;
 const filesystem:VirtualFileSystem={async openRead(){return {size:100n,readAt(){return new Promise<Uint8Array>((_resolve,reject)=>{queueMicrotask(()=>{controller.abort(reason);queueMicrotask(()=>reject(Error('late read rejection')));});});}};},async openWrite(){opens++;throw Error('must not open');}};
 const result=await new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000}}).exec(['-i','/in.flac','-map','0:m:title:cover','-c','copy','-f','framecrc','/out'],{signal:controller.signal});
 expect(result.exitCode).not.toBe(0);expect(result.outputs).toEqual([]);expect(opens).toBe(0);await new Promise<void>(done=>setTimeout(done,0));
});

it('exercises all 60 Native rows and explicit picture-mux gaps through the public backend and R2 in Workers without Node',async()=>{
 const root=resolve('tests/integration');
 const source=`import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createR2FileSystem} from '@edge-ffmpeg/storage-r2';
export default {async fetch(request,env){const {args}=await request.json();let opens=0,reads=0,maxRead=0,commits=0,aborts=0;
const fs=createR2FileSystem({bucket:env.MEDIA_BUCKET,mounts:{'/input':'input','/output':'output'},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'stage',partBytes:5242880,maxWriteBytes:65536,maxOutputBytes:1048576}});
const filesystem={async openRead(path){const handle=await fs.openRead('/input'+path);return {size:handle.size,async readAt(offset,length,signal){reads++;maxRead=Math.max(maxRead,length);return handle.readAt(offset,Math.min(19,length),signal);}};},async openWrite(path,options){opens++;const handle=await fs.openWrite('/output'+path,options);return {write:handle.write.bind(handle),async commit(){await handle.commit();commits++;},async abort(error){aborts++;await handle.abort(error);}};}};
const result=await new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000}}).exec(['-y',...args]);
return Response.json({exitCode:result.exitCode,outputs:result.outputs,code:result.diagnostics[0]?.code,diagnostics:result.diagnostics,opens,reads,maxRead,commits,aborts});}};`;
 const bundle=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'selection-public-worker.mjs'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports).toEqual([]);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/selection-public-worker.mjs',contents:bundle.outputFiles[0]!.text}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 try{await mf.ready;const bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  for(const row of corpus.rows){await bucket.put('input/in.flac',Buffer.from(row.input,'base64'));await bucket.put('output/out',sentinel);
   const response=await mf.dispatchFetch('https://selection.test/',{method:'POST',body:JSON.stringify({args:row.args})});expect(response.status,row.id).toBe(200);
   const actual=await response.json() as {exitCode:number;outputs:string[];code?:string;diagnostics:unknown;opens:number;reads:number;maxRead:number;commits:number;aborts:number};
   const pictureGap=row.exitCode===0&&row.selectedStreamIds.some(id=>id!==0);
   expect(actual.exitCode,row.id+JSON.stringify(actual.diagnostics)).toBe(pictureGap?1:row.exitCode);expect(actual.reads,row.id).toBeGreaterThan(0);expect(actual.maxRead,row.id).toBeLessThanOrEqual(65536);
   const stored=await bucket.get('output/out');expect(stored,row.id).not.toBeNull();const bytes=Buffer.from(await stored!.arrayBuffer());
   if(row.exitCode===0&&!pictureGap){expect(bytes.toString('base64'),row.id).toBe(row.output);expect(actual.outputs,row.id).toEqual(['/out']);expect(actual.commits,row.id).toBe(1);expect(actual.opens,row.id).toBe(1);expect(actual.aborts,row.id).toBe(0);}
   else{expect(actual.code,row.id).toBe(pictureGap?'unsupported-command':'invalid-arguments');expect(actual.outputs,row.id).toEqual([]);expect(bytes,row.id).toEqual(Buffer.from(sentinel));expect(actual.opens,row.id).toBe(0);expect(actual.commits,row.id).toBe(0);}
   expect((await bucket.list({prefix:'stage/'})).objects,row.id).toEqual([]);
  }
 }finally{await mf.dispose();}
},60000);
