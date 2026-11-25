import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

interface Row {
 id:string;input:string;inputSha256:string;args:string[];exitCode:number;output:string|null;outputSha256:string|null;
 boundary:string;variant:string;sampleCount?:number;canonicalSlice?:{firstSample:number;endSampleExclusive:number;exactMatch:boolean}|null;
 packets?:{pts:number;duration:number;bytes:number}[];descriptors:{sampleRate:number;channels:number;bitsPerSample:number;totalSamples:number}[];stderr:string;
}
interface Result {
 error:string|null;cancelReasonPreserved:boolean;committed:boolean;sha256:string;storedSha256:string|null;storedSize:number|null;totalBytes:number;sampleCount:number;
 frames:{samples:number;pts:string|null;timeBase:{num:string;den:string}|null;owned:number}[];
 owned:number;peak:number;reads:number;maxRead:number;shortReads:number;writes:number;maxWrite:number;sourceFrames:number;sourceReturns:number;sourceReleased:number;reservations:number;releases:number;memoryBytes:number;lateSettled:boolean;multipartLive:number;multipartCreated:number;multipartAborted:number;stages:number;
}
interface PublicResult {
 exitCode:number;diagnostics:{code:string;message:string}[];outputs:string[];sha256:string|null;size:number|null;reads:number;maxRead:number;shortReads:number;writes:number;maxWrite:number;atomicChecks:number;multipartLive:number;multipartCreated:number;multipartAborted:number;stages:number;
}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const formats=['u8','u8p','s16','s16p','s32','s32p','flt','fltp','dbl','dblp'];

/** Independent byte construction from already verified Native packed s32 PCM. */
function expectedFormat(pcm:Buffer,format:string,counts:number[],start:number,end:number):Buffer{
 const width=format.startsWith('u8')?1:format.startsWith('s16')?2:format.startsWith('dbl')?8:4,planar=format.endsWith('p'),parts:Buffer[]=[];
 let position=0;
 for(const count of counts){
  const first=Math.max(start,position),last=Math.min(end,position+count);position+=count;if(last<=first)continue;
  const out=Buffer.alloc((last-first)*2*width);let offset=0;
  const put=(sample:number,channel:number)=>{const value=pcm.readInt32LE((sample*2+channel)*4);if(format.startsWith('u8'))out.writeUInt8((Math.floor(value/16777216)+128)&255,offset);else if(format.startsWith('s16'))out.writeInt16LE(Math.trunc(value/65536),offset);else if(format.startsWith('s32'))out.writeInt32LE(value,offset);else if(format.startsWith('flt'))out.writeFloatLE(value/2147483648,offset);else out.writeDoubleLE(value/2147483648,offset);offset+=width;};
  if(planar){for(let channel=0;channel<2;channel++)for(let sample=first;sample<last;sample++)put(sample,channel);}else for(let sample=first;sample<last;sample++)for(let channel=0;channel<2;channel++)put(sample,channel);
  parts.push(out);
 }
 return Buffer.concat(parts);
}

it('trims real FLAC on local R2/workerd: Native bytes, all packed/planar formats, PTS, bounded short reads and transactional cleanup',async()=>{
 const api=JSON.parse(readFileSync('tests/fixtures/hermes-max/api/trim.json','utf8')) as {module:string};expect(api.module).toBe('packages/avformat/src/flac-wave-trim.ts');
 const corpus=JSON.parse(readFileSync('compat/behavior-specs/flac-max-trim/cases.json','utf8')) as {binarySha256:string;wasmSha256:string;rows:Row[]};
 expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');expect(corpus.rows).toHaveLength(64);
 const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');expect(sha(wasm)).toBe(corpus.wasmSha256);
 const root=resolve('tests/workers'),bundle=await build({entryPoints:[root+'/flac-max-trim-fixture.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./edge-flac.wasm'],metafile:true});
 for(const name of Object.keys(bundle.metafile!.inputs)){expect(name.startsWith('.build/')).toBe(false);expect(name.startsWith('node:')).toBe(false);expect(name.includes('runtime-node')).toBe(false);}
 for(const output of Object.values(bundle.metafile!.outputs))expect(output.imports.every(entry=>entry.path==='./edge-flac.wasm'&&entry.external)).toBe(true);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:root+'/flac-max-trim-bundle.mjs',contents:bundle.outputFiles[0]!.text},{type:'CompiledWasm',path:root+'/edge-flac.wasm',contents:wasm}],modulesRoot:root,compatibilityDate:'2026-11-18',compatibilityFlags:[],r2Buckets:['MEDIA_BUCKET']}));
 let bucket:Awaited<ReturnType<typeof mf.getR2Bucket>>|undefined;const failures:{id:string;error:string}[]=[];
 const invoke=async(params:Record<string,string>)=>{const response=await mf.dispatchFetch('https://trim.test/?'+new URLSearchParams(params));return {status:response.status,result:await response.json() as Result};};
 const clean=(result:Result)=>{expect(result.owned).toBe(0);expect(result.memoryBytes).toBe(0);expect(result.reservations).toBe(result.releases);expect(result.multipartLive).toBe(0);expect(result.stages).toBe(0);expect(result.peak).toBeLessThanOrEqual(17825792);expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxWrite).toBeLessThanOrEqual(65536);expect(result.sourceReleased).toBe(result.sourceFrames);};
 const checked=async(id:string,run:()=>Promise<void>)=>{try{await run();}catch(error){failures.push({id,error:String(error)});}};
 try{
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  const successes=corpus.rows.filter(row=>['packed-raw','planar-raw'].includes(row.variant)&&row.exitCode===0);expect(successes.length).toBeGreaterThan(0);
  const scopedErrors=corpus.rows.filter(row=>row.exitCode!==0);for(const row of scopedErrors)expect(row.stderr.length,row.id).toBeGreaterThan(0);
  for(const row of successes)await checked(row.id,async()=>{
   const input=Buffer.from(row.input,'base64');expect(sha(input)).toBe(row.inputSha256);await bucket!.put('source/input.flac',input);
   const start=row.canonicalSlice?.firstSample??(row.boundary==='ss-eof'?row.descriptors[0]!.totalSamples:0),end=row.canonicalSlice?.endSampleExclusive??start;
   const {status,result}=await invoke({format:row.variant==='planar-raw'?'s32p':'s32',start:String(start),end:String(end),pts:'17'});expect(status,JSON.stringify(result)).toBe(200);expect(result.error).toBeNull();expect(result.committed).toBe(true);expect(result.storedSha256).toBe(row.outputSha256);expect(result.sha256).toBe(row.outputSha256);expect(result.storedSize).toBe(Buffer.from(row.output!,'base64').length);expect(result.sampleCount).toBe(row.sampleCount);expect(result.totalBytes).toBe(result.sampleCount*8);
   let pts=17;for(const frame of result.frames){expect(frame.pts).toBe(String(pts));expect(frame.timeBase).toEqual({num:'1',den:String(row.descriptors[0]!.sampleRate)});expect(frame.owned).toBeGreaterThan(16777216);pts+=frame.samples;}
   if(result.sampleCount){expect(result.reads).toBeGreaterThan(0);expect(result.shortReads).toBeGreaterThan(0);}clean(result);
   expect(Buffer.from(await (await bucket!.get('output/result.raw'))!.arrayBuffer())).toEqual(Buffer.from(row.output!,'base64'));
  });
  const control=successes.find(row=>row.boundary==='baseline'&&row.variant==='packed-raw')!;expect(control).toBeDefined();await bucket.put('source/input.flac',Buffer.from(control.input,'base64'));
  const crc=corpus.rows.find(row=>row.boundary==='baseline'&&row.variant==='packed-framecrc')!;expect(crc.exitCode).toBe(0);const counts=crc.packets!.map(packet=>packet.duration),pcm=Buffer.from(control.output!,'base64');expect(counts.length).toBeGreaterThan(1);
  const start=counts[0]!-1,end=counts[0]!+2;
  for(const format of formats)await checked('format/'+format,async()=>{
   const expected=expectedFormat(pcm,format,counts,start,end),{status,result}=await invoke({format,start:String(start),end:String(end),pts:'-9'});expect(status,JSON.stringify(result)).toBe(200);expect(result.sampleCount).toBe(3);expect(result.frames.map(frame=>frame.samples)).toEqual([1,2]);expect(result.frames.map(frame=>frame.pts)).toEqual(['-9','-8']);expect(result.storedSha256).toBe(sha(expected));expect(result.storedSize).toBe(expected.length);expect(result.sourceFrames).toBe(2);expect(result.sourceReturns).toBe(1);expect(Buffer.from(await (await bucket!.get('output/result.raw'))!.arrayBuffer())).toEqual(expected);clean(result);
  });
  const ranges:{id:string;params:Record<string,string>;expected:Buffer}[]=[
   {id:'null-end',params:{start:'1'},expected:pcm.subarray(8)},
   {id:'empty-range',params:{start:'0',end:'0'},expected:Buffer.alloc(0)},
   {id:'beyond-eof',params:{start:'999999'},expected:Buffer.alloc(0)},
  ];
  for(const {id,params,expected} of ranges)await checked(id,async()=>{const {status,result}=await invoke(params);expect(status,JSON.stringify(result)).toBe(200);expect(result.storedSha256).toBe(sha(expected));expect(result.sampleCount).toBe(expected.length/8);expect(result.storedSize).toBe(expected.length);if(id==='empty-range')expect(result.sourceFrames).toBe(0);clean(result);});
  const sentinel=Buffer.from('previous-trim-output');
  for(const mode of ['cancel-write','write-failure','early-return','held-abort','pending-reject','pending-resolve','return-reject','frame-budget'])await checked(mode,async()=>{
   await bucket!.put('output/result.raw',sentinel);const {status,result}=await invoke({mode,start:'1',end:String(control.descriptors[0]!.totalSamples-1)});
   expect(status,JSON.stringify(result)).toBe(mode==='early-return'?200:422);expect(result.committed).toBe(false);expect(result.storedSha256).toBe(sha(sentinel));expect(result.storedSize).toBe(sentinel.length);expect(result.multipartCreated).toBe(1);expect(result.multipartAborted).toBe(1);if(mode==='return-reject')expect(result.error).toBe('trim source return rejected');if(['cancel-write','held-abort','pending-reject','pending-resolve'].includes(mode))expect(result.cancelReasonPreserved).toBe(true);if(mode.startsWith('pending-'))expect(result.lateSettled).toBe(true);clean(result);
  });
  const publicInvoke=async(row:Row,mode='normal')=>{
   const args=['-y','-cpuflags','0',...row.args.map(arg=>arg==='/in.flac'?'/input/input.flac':arg==='/out'?'/output/result.raw':arg)];
   const response=await mf.dispatchFetch('https://trim.test/?'+new URLSearchParams({args:JSON.stringify(args),mode}));expect(response.status).toBe(200);return await response.json() as PublicResult;
  };
  const publicClean=(result:PublicResult)=>{expect(result.multipartLive).toBe(0);expect(result.stages).toBe(0);expect(result.maxRead).toBeLessThanOrEqual(4096);expect(result.maxWrite).toBeLessThanOrEqual(65536);};
  let publicPositive=0,publicNativeNegative=0,publicExplicitGap=0;
  for(const row of corpus.rows)await checked('public/'+row.id,async()=>{
   await bucket!.put('source/input.flac',Buffer.from(row.input,'base64'));await bucket!.put('output/result.raw',sentinel);
   const result=await publicInvoke(row);
   const gap=row.variant==='planar-framecrc'?'Unsupported FLAC PCM codec: pcm_s32le_planar':row.exitCode===0&&['t-half-sample','to-half-sample'].includes(row.boundary)?'Positive FLAC output duration rounding to zero requires decoded frame boundaries':null;
   if(gap){
    // These Native successes remain unsupported, not parity-certified or skipped.
    expect(result.exitCode).not.toBe(0);expect(result.diagnostics).toContainEqual({code:'unsupported-command',message:gap});expect(result.outputs).toEqual([]);expect(result.sha256).toBe(sha(sentinel));expect(result.size).toBe(sentinel.length);expect(result.writes).toBe(0);expect(result.multipartCreated).toBe(0);publicExplicitGap++;
   }else if(row.exitCode===0){
    expect(result.exitCode,JSON.stringify(result)).toBe(0);expect(result.outputs).toEqual(['/output/result.raw']);expect(result.sha256).toBe(row.outputSha256);expect(result.size).toBe(Buffer.from(row.output!,'base64').length);expect(result.atomicChecks).toBeGreaterThan(0);expect(result.shortReads).toBeGreaterThan(0);expect(Buffer.from(await (await bucket!.get('output/result.raw'))!.arrayBuffer())).toEqual(Buffer.from(row.output!,'base64'));
    publicPositive++;
   }else{
    // Native pcm_s32le rejects planar sample_fmt; fail closed, do not call it parity.
    expect(result.exitCode).not.toBe(0);expect(result.diagnostics.length).toBeGreaterThan(0);expect(result.outputs).toEqual([]);expect(result.sha256).toBe(sha(sentinel));expect(result.size).toBe(sentinel.length);
    publicNativeNegative++;
   }
   publicClean(result);
  });
  expect({publicPositive,publicNativeNegative,publicExplicitGap}).toEqual({publicPositive:28,publicNativeNegative:16,publicExplicitGap:20});
  await bucket.put('source/input.flac',Buffer.from(control.input,'base64'));
  for(const mode of ['cancel-write','write-failure','output-budget'])await checked('public/'+mode,async()=>{
   await bucket!.put('output/result.raw',sentinel);const result=await publicInvoke(control,mode);expect(result.exitCode,JSON.stringify(result)).not.toBe(0);expect(result.outputs).toEqual([]);expect(result.sha256).toBe(sha(sentinel));expect(result.size).toBe(sentinel.length);expect(result.multipartCreated).toBeGreaterThan(0);expect(result.multipartAborted).toBe(result.multipartCreated);publicClean(result);
  });
  expect(failures).toEqual([]);
 }finally{
  if(bucket){const stages=(await bucket.list({prefix:'trim-stage/'})).objects;expect(stages).toEqual([]);await bucket.delete('source/input.flac');await bucket.delete('output/result.raw');expect((await bucket.list()).objects).toEqual([]);}
  await mf.dispose();
 }
},120000);
