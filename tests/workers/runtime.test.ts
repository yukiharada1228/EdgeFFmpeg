import {nativeWavOutput} from '../helpers/native-wav.js';
import { openWav } from '@edge-ffmpeg/containers';
import { memoryInput } from '../helpers/wav.js';
import { chunk, riff, pcmFormat } from '../helpers/wav.js';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
let mf: Miniflare;
for(const [arithmetic,route]of [['aarch64','pixel-resize-inverse-r2'],['x86_64','pixel-resize-inverse-linux-r2']] as const)it(`matches native ${arithmetic} resized inverse profiles through bounded R2 staging in workerd`,async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/resize-inverse-worker.json','utf8')) as {cases:{format:string;destination:string;native:Record<'aarch64'|'x86_64',string>}[]},response=await mf.dispatchFetch(`https://test/${route}`),results=await response.json() as {format:string;destination:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(42);for(const result of results){const label=`${result.format}/${result.destination}`;expect(result.exitCode,label).toBe(0);expect(result.reads,label).toBeGreaterThan(1);expect(result.staging,label).toBe(0);expect(result.text,label).toBe(fixture.cases.find(c=>c.format===result.format&&c.destination===result.destination)!.native[arithmetic]);}
});
it('resizes all six YUV layouts through bounded R2 reads and staged workerd framecrc output',async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/resize-yuv-worker.json','utf8')) as {cases:{format:string;framecrc:string}[]};
 const response=await mf.dispatchFetch('https://test/pixel-resize-yuv-r2'),results=await response.json() as {format:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(6);
 for(const result of results){expect(result.exitCode,result.format).toBe(0);expect(result.reads,result.format).toBeGreaterThan(1);expect(result.staging,result.format).toBe(0);expect(result.text,result.format).toBe(fixture.cases.find(item=>item.format===result.format)!.framecrc);}
});
it('executes fused resize and format conversion through bounded R2 reads and staged workerd output',async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/resize-combined-worker.json','utf8')) as {cases:{format:string;destination:string;framecrc:string}[]};
 const response=await mf.dispatchFetch('https://test/pixel-resize-combined-r2'),results=await response.json() as {format:string;destination:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(8);
 for(const result of results){expect(result.exitCode,`${result.format}/${result.destination}`).toBe(0);expect(result.reads).toBeGreaterThan(1);expect(result.staging).toBe(0);expect(result.text).toBe(fixture.cases.find(item=>item.format===result.format&&item.destination===result.destination)!.framecrc);}
});
it('resizes all seven RGB layouts through bounded R2 reads and staged workerd framecrc output',async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/resize-rgb-worker.json','utf8')) as {cases:{format:string;framecrc:string}[]};
 const response=await mf.dispatchFetch('https://test/pixel-resize-rgb-r2'),results=await response.json() as {format:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(7);
 for(const result of results){expect(result.exitCode,result.format).toBe(0);expect(result.reads,result.format).toBeGreaterThan(1);expect(result.staging,result.format).toBe(0);expect(result.text,result.format).toBe(fixture.cases.find(item=>item.format===result.format)!.framecrc);}
});
it('resizes gray video with native timestamps and framecrc through staged R2 output in workerd',async()=>{
 const response=await mf.dispatchFetch('https://test/pixel-resize-r2'),result=await response.json() as {exitCode:number;text:string;reads:number;staging:number};
 expect(result.exitCode).toBe(0);expect(result.reads).toBeGreaterThan(1);expect(result.staging).toBe(0);
 expect(result.text).toBe('#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 13x7\n#sar 0: 0/1\n0,          1,          1,        1,       91, 0xdf2c2c67\n');
});
for(const [arithmetic,route]of [['aarch64','video-filter-format-r2'],['x86_64','video-filter-format-linux-r2']] as const)it(`negotiates video filter formats with ${arithmetic} arithmetic through bounded R2 staging`,async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/filter-format-worker.json','utf8')) as {cases:{id:string;native:Record<'aarch64'|'x86_64',string>}[]},response=await mf.dispatchFetch(`https://test/${route}`),results=await response.json() as {id:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(8);for(const result of results){expect(result.exitCode,result.id).toBe(0);expect(result.reads,result.id).toBeGreaterThan(1);expect(result.staging,result.id).toBe(0);expect(result.text,result.id).toBe(fixture.cases.find(c=>c.id===result.id)!.native[arithmetic]);}
});
for(const [arithmetic,route]of [['aarch64','video-filter-lists-r2'],['x86_64','video-filter-lists-linux-r2']] as const)it(`negotiates video filter candidate lists with ${arithmetic} arithmetic through bounded R2 staging`,async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/filter-lists-worker.json','utf8')) as {cases:{id:string;native:Record<'aarch64'|'x86_64',string>}[]},response=await mf.dispatchFetch(`https://test/${route}`),results=await response.json() as {id:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(8);for(const result of results){expect(result.exitCode,result.id).toBe(0);expect(result.reads,result.id).toBeGreaterThan(1);expect(result.staging,result.id).toBe(0);expect(result.text,result.id).toBe(fixture.cases.find(c=>c.id===result.id)!.native[arithmetic]);}
});
for(const [arithmetic,route]of [['aarch64','video-filter-flip-r2'],['x86_64','video-filter-flip-linux-r2']] as const)it(`matches native ${arithmetic} video flips through bounded R2 staging`,async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/filter-flip-worker.json','utf8')) as {cases:{id:string;native:Record<'aarch64'|'x86_64',string>}[]},response=await mf.dispatchFetch(`https://test/${route}`),results=await response.json() as {id:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(8);for(const result of results){expect(result.exitCode,result.id).toBe(0);expect(result.reads,result.id).toBeGreaterThan(1);expect(result.staging,result.id).toBe(0);expect(result.text,result.id).toBe(fixture.cases.find(item=>item.id===result.id)!.native[arithmetic]);}
});
for(const [arithmetic,route]of [['aarch64','video-filter-numeric-r2'],['x86_64','video-filter-numeric-linux-r2']] as const)it(`matches native ${arithmetic} numeric format candidates through bounded R2 staging`,async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/filter-numeric-worker.json','utf8')) as {cases:{id:string;native:Record<'aarch64'|'x86_64',string>}[]},response=await mf.dispatchFetch(`https://test/${route}`),results=await response.json() as {id:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(8);for(const result of results){expect(result.exitCode,result.id).toBe(0);expect(result.reads,result.id).toBeGreaterThan(1);expect(result.staging,result.id).toBe(0);expect(result.text,result.id).toBe(fixture.cases.find(item=>item.id===result.id)!.native[arithmetic]);}
});
for(const [arithmetic,route]of [['aarch64','video-filter-quoted-r2'],['x86_64','video-filter-quoted-linux-r2']] as const)it(`matches native ${arithmetic} quoted video filter options through bounded R2 staging`,async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/filter-quoted-worker.json','utf8')) as {cases:{id:string;native:Record<'aarch64'|'x86_64',string>}[]},response=await mf.dispatchFetch(`https://test/${route}`),results=await response.json() as {id:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(8);for(const result of results){expect(result.exitCode,result.id).toBe(0);expect(result.reads,result.id).toBeGreaterThan(1);expect(result.staging,result.id).toBe(0);expect(result.text,result.id).toBe(fixture.cases.find(item=>item.id===result.id)!.native[arithmetic]);}
});
it('executes a linear video filter chain through bounded R2 input and staged workerd output',async()=>{
 const response=await mf.dispatchFetch('https://test/video-filter-r2'),result=await response.json() as {exitCode:number;text:string;reads:number;staging:number};
 expect(result.exitCode).toBe(0);expect(result.reads).toBeGreaterThan(1);expect(result.staging).toBe(0);
 expect(result.text).toBe('#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 13x7\n#sar 0: 0/1\n0,          1,          1,        1,       91, 0xdf2c2c67\n');
});
it('matches locked Linux default MMXEXT inverse profiles through bounded workerd CLI execution',async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/inverse-linux-x64.json','utf8')) as {cases:{id:string;native:{default:string}}[]};
 const response=await mf.dispatchFetch('https://test/pixel-inverse-linux'),results=await response.json() as {id:string;exitCode:number;committed:boolean;reads:number;sha256:string}[];
 expect(results).toHaveLength(6);
 for(const result of results){expect(result.exitCode,result.id).toBe(0);expect(result.committed,result.id).toBe(true);expect(result.reads,result.id).toBeGreaterThan(1);expect(result.sha256,result.id).toBe(fixture.cases.find(item=>item.id===result.id)!.native.default);}
});
beforeAll(async () => {
  const bundled = await build({ entryPoints: ['tests/workers/fixture.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')) as { compatibility_date: string };
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0]!.text, compatibilityDate: config.compatibility_date, r2Buckets: ['MEDIA_BUCKET'] }));
  await mf.ready;
}, 30000);
afterAll(async () => { await mf?.dispose(); });
async function seed() {
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET');
  await bucket.put('source/example', '0123456789');
}
it('reads bounded R2 ranges and rescales timestamps inside workerd', async () => {
  await seed();
  const response = await mf.dispatchFetch('https://test/read');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ size: '10', data: [50,51,52,53,54,55,56,57], pts: '100' });
});
it('detects replacements including identical bytes with a new generation', async () => {
  for (const route of ['mutation', 'same-bytes']) {
    await seed();
    const response = await mf.dispatchFetch(`https://test/${route}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('detected');
  }
});
it('rejects traversal, oversize ranges and cancellation, and handles EOF', async () => {
  await seed();
  const response = await mf.dispatchFetch('https://test/bounds');
  expect(await response.json()).toEqual({ rejected: 7, empty: 0, tail: [57] });
});
it('isolates allocation budgets per request', async () => {
  for (let i = 0; i < 2; i++) {
    const response = await mf.dispatchFetch('https://test/budget');
    expect(await response.json()).toEqual({ rejected: true, allocated: 8 });
  }
});

it('applies packet backpressure inside workerd without losing order', async () => {
  const response = await mf.dispatchFetch('https://test/queue');
  expect(response.status).toBe(200);
  const result = await response.json() as { values: number[]; maximum: number; pending: number };
  expect(result.values).toEqual(Array.from({ length: 12 }, (_, i) => i));
  expect(result.maximum).toBeLessThanOrEqual(2);
  expect(result.pending).toBe(0);
});

it('resolves immutable descriptors and plans a graph inside workerd', async () => {
  const response = await mf.dispatchFetch('https://test/plan');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ order: ['a', 'b'], memory: 4, slots: 2, immutable: true });
});

it('demuxes PCM WAV from bounded R2 reads inside workerd', async () => {
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET');
  await bucket.put('source/audio.wav', riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array([1,0,2,0,3,0,4,0,5,0]))]));
  const response = await mf.dispatchFetch('https://test/wav');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ codec: 'pcm_s16le', duration: '5', packets: [
    { pts: '0', duration: '4', bytes: [1,0,2,0,3,0,4,0] }, { pts: '4', duration: '1', bytes: [5,0] }
  ] });
});

it('remuxes R2 PCM input through bounded transactional writes inside workerd', async () => {
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET');
  const bytes = riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array([1,0,2,0,3,0,4,0,5,0]))]);
  await bucket.put('source/audio.wav', bytes);
  const response = await mf.dispatchFetch('https://test/wav-remux');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ committed: true, bounded: true, bytes: [...bytes] });
});

it('executes FFmpeg argv through the WAV backend inside workerd', async () => {
  const bytes = riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array([1,0,2,0]))]);
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET'); await bucket.put('source/audio.wav', bytes);
  const response = await mf.dispatchFetch('https://test/exec');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ result: { exitCode: 0, diagnostics: [], outputs: ['/output/audio.wav'] }, committed: true, bytes: [...nativeWavOutput(bytes)] });
});

it('commits WAV output to R2 and removes its staging object', async () => {
  const bytes = riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array([1,0,2,0]))]);
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET'); await bucket.put('source/audio.wav', bytes);
  const response = await mf.dispatchFetch('https://test/r2-output/wav');
  expect(await response.json()).toEqual({ exitCode: 0, diagnostics: [], remaining: 0 });
  expect(new Uint8Array(await (await bucket.get('result/actual.wav'))!.arrayBuffer())).toEqual(nativeWavOutput(bytes));
});
it('uploads multiple R2 parts without exposing output before commit', async () => {
  const response = await mf.dispatchFetch('https://test/r2-output/large');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ visibleBefore: false, size: 8 * 1024 * 1024, remaining: 0 });
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET');
  const bytes = new Uint8Array(await (await bucket.get('result/large'))!.arrayBuffer());
  for (let i = 0; i < 128; i++) expect(bytes.subarray(i * 65536, (i + 1) * 65536).every(value => value === i)).toBe(true);
});
it('enforces conditional no-clobber publication and explicit replacement in R2', async () => {
  const response = await mf.dispatchFetch('https://test/r2-output/collision');
  expect(await response.json()).toEqual({ rejected: true, remaining: 0 });
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET');
  expect([...new Uint8Array(await (await bucket.get('result/collision'))!.arrayBuffer())]).toEqual([3]);
});
it('retains uncertain publication evidence and positively recovers by transaction marker', async () => {
  const response = await mf.dispatchFetch('https://test/r2-output/uncertain');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ retained: 1, unresolved: false, recovered: true, remaining: 0 });
});
it('aborts staged R2 writes and supports empty output', async () => {
  expect(await (await mf.dispatchFetch('https://test/r2-output/abort')).json()).toEqual({ visible: false, remaining: 0 });
  expect(await (await mf.dispatchFetch('https://test/r2-output/empty')).json()).toEqual({ size: 0, remaining: 0 });
});

it('cleans up staging even when multipart completion acknowledgement is lost', async () => {
  const response = await mf.dispatchFetch('https://test/r2-output/staging-failure');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ failed: true, visible: false, remaining: 0 });
});
it('enforces R2 write/total budgets and rejects unsafe staging configuration', async () => {
  const response = await mf.dispatchFetch('https://test/r2-output/limits');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ rejected: 2, invalid: 2, protectedInput: true, remaining: 0 });
});

it('distinguishes published output from staging cleanup failure and recovers it', async () => {
  const response = await mf.dispatchFetch('https://test/r2-output/cleanup-failure');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ published: true, recovered: true, remaining: 0 });
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET');
  expect((await bucket.head('result/cleanup-failure'))?.size).toBe(1);
});

it('converts integer PCM and commits the WAV result to R2 inside workerd', async () => {
  const bucket = await mf.getR2Bucket('MEDIA_BUCKET');
  const input=riff([chunk('fmt ', pcmFormat()), chunk('data', new Uint8Array([0,128,0,0,255,127]))]);
  await bucket.put('source/audio.wav',input);
  const response = await mf.dispatchFetch('https://test/r2-output/pcm');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ exitCode: 0, diagnostics: [], remaining: 0 });
  const bytes = new Uint8Array(await (await bucket.get('result/converted.wav'))!.arrayBuffer());
  expect(bytes).toEqual(nativeWavOutput(input,['-c:a','pcm_u8']));
  const decoded=await openWav(memoryInput(bytes),{maxReadBytes:64});expect(bytes.slice(Number(decoded.info.dataOffset),Number(decoded.info.dataOffset+decoded.info.dataBytes))).toEqual(new Uint8Array([0,128,255]));
});

it('runs all six PCM decoder/encoder pairs including floating payload bits inside workerd', async () => {
  const response = await mf.dispatchFetch('https://test/pcm-codecs');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    pcm_u8: { same: [0,128,255], unsigned: [0,128,255] },
    pcm_s16le: { same: [0,128,0,0,255,127], unsigned: [0,128,255] },
    pcm_s24le: { same: [0,0,128,0,0,0,255,255,127], unsigned: [0,128,255] },
    pcm_s32le: { same: [0,0,0,128,0,0,0,0,255,255,255,127], unsigned: [0,128,255] },
    pcm_f32le: { same: [0x34,0x12,0xc0,0x7f] }, pcm_f64le: { same: [1,0,0,0,0,0,0xf8,0x7f] }
  });
});

it('uses deterministic scalar half-way rounding for float-to-integer frames inside workerd', async () => {
  const response=await mf.dispatchFetch('https://test/sample-formats');
  expect(response.status).toBe(200); expect(await response.json()).toEqual({values:[-32768,-2,0,0,2,32767]});
});
it('converts integer WAV to floating PCM and stores the result in R2', async () => {
  const bucket=await mf.getR2Bucket('MEDIA_BUCKET');
  await bucket.put('source/audio.wav',riff([chunk('fmt ',pcmFormat()),chunk('data',new Uint8Array([0,128,0,0,255,127]))]));
  const response=await mf.dispatchFetch('https://test/r2-output/pcm-float');
  expect(await response.json()).toEqual({exitCode:0,diagnostics:[],remaining:0});
  const result=await openWav(memoryInput(new Uint8Array(await (await bucket.get('result/float.wav'))!.arrayBuffer())),{maxReadBytes:16});
  expect(result.info.codec).toBe('pcm_f32le'); const samples=[];
  for await(const packet of result.packets()) {const view=new DataView(packet.data.buffer);for(let i=0;i<packet.data.length;i+=4)samples.push(view.getFloat32(i,true));}
  expect(samples).toEqual([-1,0,32767/32768]);
});

it('uses distinct native copy/encode trim boundaries while committing R2 WAV output', async () => {
  const bucket=await mf.getR2Bucket('MEDIA_BUCKET'), data=new Uint8Array(40), view=new DataView(data.buffer);
  for(let i=0;i<20;i++)view.setInt16(i*2,i,true);
  const input=riff([chunk('fmt ',pcmFormat(1,10,16)),chunk('data',data)]);await bucket.put('source/audio.wav',input);
  const response=await mf.dispatchFetch('https://test/r2-output/time');expect(response.status).toBe(200);
  expect(await response.json()).toEqual({codes:[0,0],remaining:0});
  for(const [codec,expected] of [['copy',[2,0,3,0,4,0]],['pcm_s16le',[2,0,3,0,4,0,5,0]]] as const) {
    const bytes=new Uint8Array(await (await bucket.get(`result/time-${codec}.wav`))!.arrayBuffer());
    expect(bytes).toEqual(nativeWavOutput(input,['-ss','0.15','-t','0.35','-c:a',codec]));
    const decoded=await openWav(memoryInput(bytes),{maxReadBytes:64});expect(bytes.slice(Number(decoded.info.dataOffset),Number(decoded.info.dataOffset+decoded.info.dataBytes))).toEqual(new Uint8Array(expected));
  }
});

it('filters PCM volume with scalar clipping/rounding and persists output to R2',async()=>{
  const bucket=await mf.getR2Bucket('MEDIA_BUCKET'),data=new Uint8Array(8),view=new DataView(data.buffer);
  [1000,-1000,32767,-32768].forEach((value,i)=>view.setInt16(i*2,value,true));
  const input=riff([chunk('fmt ',pcmFormat()),chunk('data',data)]);await bucket.put('source/audio.wav',input);
  const response=await mf.dispatchFetch('https://test/r2-output/volume');expect(response.status).toBe(200);
  expect(await response.json()).toEqual({exitCode:0,diagnostics:[],remaining:0});
  const output=new Uint8Array(8),expected=new DataView(output.buffer);[500,-500,16384,-16384].forEach((value,i)=>expected.setInt16(i*2,value,true));
  const actual=new Uint8Array(await (await bucket.get('result/volume.wav'))!.arrayBuffer());expect(actual).toEqual(nativeWavOutput(input,['-af','anull,volume=0.5,anull','-c:a','pcm_s16le'],['-cpuflags','0']));
  const decoded=await openWav(memoryInput(actual),{maxReadBytes:64});expect(actual.slice(Number(decoded.info.dataOffset),Number(decoded.info.dataOffset+decoded.info.dataBytes))).toEqual(output);
});

it('reads declared raw PCM, filters it and persists headerless default float output in R2',async()=>{
  const bucket=await mf.getR2Bucket('MEDIA_BUCKET');await bucket.put('source/audio.raw',new Uint8Array([0,128,0,0,255,127]));
  const response=await mf.dispatchFetch('https://test/r2-output/raw');expect(response.status).toBe(200);expect(await response.json()).toEqual({exitCode:0,diagnostics:[],remaining:0});
  const bytes=await (await bucket.get('result/audio.raw'))!.arrayBuffer(),view=new DataView(bytes);expect(bytes.byteLength).toBe(12);
  expect([view.getFloat32(0,true),view.getFloat32(4,true),view.getFloat32(8,true)]).toEqual([-0.5,0,32767/65536]);
});

it('writes bounded framecrc text with exact bigint timestamps inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/framecrc');
  const result=await response.json() as {text:string;committed:boolean;maximum:number};
  expect(result.committed).toBe(true);expect(result.maximum).toBeLessThanOrEqual(7);
  expect(result.text).toBe('#tb 0: 1/10\n#media_type 0: audio\n#codec_id 0: pcm_s16le\n#sample_rate 0: 10\n#channel_layout_name 0: mono\n0,         -1, 9007199254740993,        1,        2, 0x02fd01fe\n');
});

it('runs CLI framecrc with native packet boundaries across tiny workerd buffers',async()=>{
  const response=await mf.dispatchFetch('https://test/framecrc-cli');
  const result=await response.json() as {exitCode:number;text:string;maximum:number};
  expect(result.exitCode).toBe(0);expect(result.maximum).toBeLessThanOrEqual(8);
  expect(result.text).toContain('0,        432,        432,      512,     1024, 0x');
  expect(result.text).toContain('0,        944,        944,        1,        2, 0x');
  expect(result.text).toContain('#channel_layout_name 0: 1 channels\n');
  expect(result.text.trim().split('\n')).toHaveLength(7);
});

it('applies exact fixed-point volume rounding and clipping inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/fixed-volume');
  expect(await response.json()).toEqual({values:[-1073741824,-1,0,1,2,1073741824],scalarRequired:false});
});

it('limits native PCM packet count in workerd without reading beyond the selected packet',async()=>{
  const response=await mf.dispatchFetch('https://test/framecrc-cli-limit');
  const result=await response.json() as {exitCode:number;text:string;maximum:number;reads:number};
  expect(result.exitCode).toBe(0);expect(result.maximum).toBeLessThanOrEqual(8);expect(result.reads).toBe(128);
  expect(result.text.trim().split('\n')).toHaveLength(6);expect(result.text).toContain('0,        432,        432,      512,     1024, 0x');
});

it('reinterprets rate before output seeking and packet limiting inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/asetrate-cli');
  const result=await response.json() as {exitCode:number;text:string;maximum:number;reads:number};
  expect(result.exitCode).toBe(0);expect(result.maximum).toBeLessThanOrEqual(8);expect(result.reads).toBe(103);
  expect(result.text).toContain('#tb 0: 1/20000\n');expect(result.text).toContain('#sample_rate 0: 20000\n');
  expect(result.text).toContain('0,          0,          0,      412,      824, 0x');expect(result.text.trim().split('\n')).toHaveLength(6);
});

it('reframes and pads unsigned PCM across workerd reads before encoding',async()=>{
  const response=await mf.dispatchFetch('https://test/asetnsamples-cli');
  const result=await response.json() as {exitCode:number;committed:boolean;text:string;reads:number};
  expect(result.exitCode).toBe(0);expect(result.committed).toBe(true);expect(result.reads).toBe(2);
  expect(result.text).toContain('0,          0,          0,        3,        6, 0x02ff00ff\n');
  expect(result.text).toContain('0,          3,          3,        3,        6, 0x03070101\n');
});

it('plans aggregate PCM buffers inside workerd and rejects fixed work before output',async()=>{
  const response=await mf.dispatchFetch('https://test/pcm-memory');
  expect(await response.json()).toEqual([{exitCode:0,diagnostic:null,maxRead:9,opens:1,bytes:200},{exitCode:1,diagnostic:'resource-budget',maxRead:0,opens:0,bytes:0}]);
});

it('decodes and encodes G711 with exact samples and bigint timestamps inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/g711');
  expect(await response.json()).toEqual({samples:[-32124,32124,0,0,8,-8],pts:'9007199254740993',codes:[0,128,255,255,254,126]});
  const cli=await mf.dispatchFetch('https://test/g711-cli');expect(await cli.json()).toEqual({exitCode:0,committed:true,samples:[-8,8,-32256,32256]});
});

it('matches locked native G711 domain hashes for every codeword and signed16 input in workerd',async()=>{
  const golden=JSON.parse(readFileSync('compat/behavior-specs/g711-domains.json','utf8')) as {upstreamCommit:string;cases:unknown};
  const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string};expect(golden.upstreamCommit).toBe(lock.commit);
  const response=await mf.dispatchFetch('https://test/g711-domains');expect(await response.json()).toEqual(golden.cases);
});

it('converts endian and unsigned PCM representations inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/pcm-endian');expect(await response.json()).toEqual({values:[-2147483648,0,2147483392],pts:'9007199254740993',encoded:[0,0,0,128,0,0,255,255,255]});
  const cli=await mf.dispatchFetch('https://test/pcm-endian-cli');expect(await cli.json()).toEqual({exitCode:0,bytes:[128,0,0,0,127,255],committed:true});
});

it('streams AIFC through staged R2 output and auto-detected decode inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/aiff-r2');expect(response.status).toBe(200);
  expect(await response.json()).toEqual({encoded:0,decoded:0,container:'aifc',codec:'pcm_f32be',samples:'3',rate:8000,bytes:[0,128,0,0,255,127],staging:0});
});

it('remixes mono stereo PCM and reproduces fused/separate arithmetic inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/remix');expect(await response.json()).toEqual({separate:-0.17125242948532104,fused:-0.17125239968299866,exitCode:0,bytes:[255,255,2,0,0,0]});
});

it('streams AU through staged R2 output and auto-detected decode inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/au-r2');expect(response.status).toBe(200);
  expect(await response.json()).toEqual({encoded:0,decoded:0,container:'au',codec:'pcm_s16be',samples:'3',bytes:[0,128,0,0,255,127],staging:0});
});

it('resamples default double Kaiser audio with bounded history and delayed flush inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/resample');const result=await response.json() as {samples:number;frames:number;first:number[]};expect(result.samples).toBe(128);expect(result.frames).toBe(16);
  for(const [i,value]of [1,0.6339873142587508,0,-0.20442457309103165,0].entries())expect(Math.abs(result.first[i]!-value)).toBeLessThanOrEqual(2e-12);
});

it('resamples CLI double audio into staged R2 WAV output with correct rate count and samples',async()=>{
  const response=await mf.dispatchFetch('https://test/resample-cli-r2');expect(response.status).toBe(200);const result=await response.json() as {exitCode:number;rate:number;samples:string;first:number[];staging:number};expect(result).toMatchObject({exitCode:0,rate:16000,samples:'128',staging:0});
  for(const [i,value]of [1,0.6339873142587508,0,-0.20442457309103165,0].entries())expect(Math.abs(result.first[i]!-value)).toBeLessThanOrEqual(2e-12);
});

it('interpolates default resampling phase tables above 1024 phases inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/resample-fallback');const result=await response.json() as {samples:number;frames:number;first:number[]};expect(result.samples).toBe(129);expect(result.frames).toBe(17);
  for(const [i,value]of [1,0.6340272466218384,0.00006153007159545794,-0.20443822167907788,-0.000058505967154028816].entries())expect(Math.abs(result.first[i]!-value)).toBeLessThanOrEqual(2e-12);
});

it('resamples float32 with bounded four-byte state and interpolation inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/resample-float');const result=await response.json() as {samples:number;first:number[]};expect(result.samples).toBe(129);
  for(const [i,value]of [1,0.6340272426605225,0.00006153007416287437,-0.2044382244348526,-0.000058505967899691314].entries())expect(Math.abs(result.first[i]!-value)).toBeLessThanOrEqual(1e-6);
});
it('resamples G711 into floating AU output through staged R2 inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/resample-cli-float-r2');expect(response.status).toBe(200);const result=await response.json() as {exitCode:number;rate:number;samples:string;codec:string;first:number[];staging:number};expect(result).toMatchObject({exitCode:0,rate:16001,samples:'129',codec:'pcm_f32be',staging:0});
  for(const [i,value]of [-0.5740966796875,-0.4177951514720917,-0.11124041676521301,0.048593610525131226,-0.0198663417249918].entries())expect(Math.abs(result.first[i]!-value)).toBeLessThanOrEqual(1e-6);
});

it('resamples fixed signed16 with quantized coefficients and interpolation inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/resample-fixed');expect(await response.json()).toEqual({samples:129,first:[32766,20775,2,-6699,-2]});
});
it('resamples unsigned8 into default integer WAV output through staged R2 inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/resample-cli-fixed-r2');expect(response.status).toBe(200);expect(await response.json()).toEqual({exitCode:0,rate:16001,samples:'129',codec:'pcm_s16le',first:[-29439,-26695,-19968,-13520,-10496],staging:0});
});

it('executes mixed-precision rate conversion before volume and FIFO inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/resample-mixed');const result=await response.json() as {exitCode:number;committed:boolean;samples:number;first:number[]};expect(result).toMatchObject({exitCode:0,committed:true,samples:133});
  for(const [i,value]of [0.4999847412109375,0.31700393557548523,0.000030764098482904956,-0.10221599042415619,-0.00002925209264503792].entries())expect(Math.abs(result.first[i]!-value)).toBeLessThanOrEqual(1e-6);
});

it('negotiates aformat double precision before resampling and FIFO inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/aformat');const result=await response.json() as {exitCode:number;committed:boolean;samples:number;first:number[]};expect(result).toMatchObject({exitCode:0,committed:true,samples:133});
  for(const [i,value]of [0.999969482421875,0.6340078711509705,0.00006152819696580991,-0.20443198084831238,-0.00005850418529007584].entries())expect(Math.abs(result.first[i]!-value)).toBeLessThanOrEqual(1e-6);
});

it('converts packed and planar precision with channel ownership and bigint timestamps inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/planar');expect(await response.json()).toEqual({format:'dblp',planes:[[-1,-1/32768,0],[32767/32768,1/32768,2/32768]],pts:'9007199254740993',packed:[0,128,255,127,255,255,1,0,0,0,2,0],encoded:[128,0,127,255,255,255,0,1,0,0,0,2],owned:true});
});

it('encodes planar signed16 G711 without a packed scratch buffer inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/planar-g711');expect(await response.json()).toEqual({bytes:[0,128,255,255,128,0],pts:'9007199254740993',duration:'3',input:[0,128,0,0,255,127,255,127,0,0,1,128]});
});

it('reframes planar channels with bounded aggregate buffers and per-channel silence inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/planar-reframe');expect(await response.json()).toEqual([{samples:3,pts:'9007199254740993',planes:[[1,2,3],[9,8,7]]},{samples:3,pts:'9007199254740996',planes:[[4,128,128],[6,128,128]]}]);
});

it('resamples planar stereo channels directly with bounded FIR state inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/planar-resample');const result=await response.json() as {samples:number;first:number[][]};expect(result.samples).toBe(129);
  for(const [i,value]of [1,0.6340272466218384,0.00006153007159545794,-0.20443822167907788,-0.000058505967154028816].entries()){expect(Math.abs(result.first[0]![i]!-value)).toBeLessThanOrEqual(2e-12);expect(Math.abs(result.first[1]![i]!+value)).toBeLessThanOrEqual(2e-12);}
});

it('remixes planar mono stereo with fixed rounding and bigint PTS inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/planar-remix');expect(await response.json()).toEqual({mono:[[-1,2,0]],stereo:[[-1,1,0],[-1,1,0]],pts:'9007199254740993',layout:'stereo'});
});

it('processes planar input through rate FIFO and volume filters inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/planar-filters');expect(await response.json()).toEqual([{format:'s16',rate:11025,pts:'9007199254740993',values:[-16384,0,16384,1,0,0]}]);
});

it('executes planar CLI constraints with native packing-dependent rate placement inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/aformat-planar');const result=await response.json() as {exitCode:number;committed:boolean;samples:number;first:number[]};expect(result).toMatchObject({exitCode:0,committed:true,samples:141});
  for(const [i,value]of [0.999969482421875,0.6340078976458063,0.00006152819384669102,-0.20443198271967605,-0.00005850418169360544].entries())expect(Math.abs(result.first[i]!-value)).toBeLessThanOrEqual(2e-12);
});

it('appends finite planar silence packets with bounded allocation inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/pad-audio');expect(await response.json()).toEqual([{samples:2,pts:'9007199254740993',planes:[[1,2],[9,8]]},{samples:3,pts:'9007199254740995',planes:[[128,128,128],[128,128,128]]},{samples:2,pts:'9007199254740998',planes:[[128,128],[128,128]]}]);
});

it('executes finite apad through the CLI with bounded raw output inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/apad-cli');expect(await response.json()).toEqual({exitCode:0,committed:true,bytes:[0,128,0,0,255,127,0,0,0,0]});
});

it('executes minimum-length padding with exact small buffer reservations inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/apad-whole-cli');expect(await response.json()).toEqual({exitCode:0,committed:true,bytes:[0,128,0,0,255,127,0,0,0,0]});
});

it('resolves whole-duration padding to exact sample counts inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/apad-duration-cli');expect(await response.json()).toEqual({exitCode:0,committed:true,bytes:[0,128,0,0,255,127,0,0,0,0]});
});

it('selects output time ranges inside finite apad silence inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/apad-trim-cli');expect(await response.json()).toEqual({exitCode:0,committed:true,bytes:[0,0,0,0,0,0]});
});

it('limits finite apad output frames after seeking inside a silence packet inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/apad-frame-cli');expect(await response.json()).toEqual({exitCode:0,committed:true,bytes:[0,0,0,0,0,0]});
});
it('resamples finite padding before rate conversion and pads after an empty resampler drain inside workerd',async()=>{
  const before=await mf.dispatchFetch('https://test/apad-resample-before'),result=await before.json() as {exitCode:number;committed:boolean;samples:number;first:number[]};expect(result).toMatchObject({exitCode:0,committed:true,samples:140});
  const expected=[0.999969482421875,0.633967936038971,0,-0.2044183313846588,0];for(let i=0;i<expected.length;i++)expect(Math.abs(result.first[i]!-expected[i]!)).toBeLessThanOrEqual(1e-6);
  const after=await mf.dispatchFetch('https://test/apad-resample-after');expect(await after.json()).toEqual({exitCode:0,committed:true,samples:5,first:[0,0,0,0,0]});
});
it('preserves nonzero fixed resampler framecrc boundaries after seeking and limiting output frames inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/resample-framecrc');expect(await response.json()).toEqual({exitCode:0,committed:true,text:'#tb 0: 1/16001\n#media_type 0: audio\n#codec_id 0: pcm_s16le\n#sample_rate 0: 16001\n#channel_layout_name 0: mono\n0,          0,          0,       95,      190, 0x44f359e9\n0,         95,         95,       32,       64, 0x13381fe8\n'});
});
it('decodes and encodes odd-sized rawvideo with rational framecrc timestamps and short reads inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/raw-video');expect(await response.json()).toEqual({exitCode:0,committed:true,reads:18,text:'#tb 0: 1001/30000\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 5x3\n#sar 0: 0/1\n0,          0,          0,        1,       27, 0x0ccc015f\n0,          1,          1,        1,       27, 0x0ccc015f\n'});
});
it('writes frame-limited NV12 rawvideo through staged R2 output inside workerd',async()=>{
  const response=await mf.dispatchFetch('https://test/raw-video-r2');expect(await response.json()).toEqual({exitCode:0,bytes:Array.from({length:54},(_,i)=>(i*37+13)&255),staging:0});
});

it('selects rawvideo output time boundaries and preserves encoder PTS inside workerd',async()=>{
 const response=await mf.dispatchFetch('https://test/raw-video-time');expect(await response.json()).toEqual({exitCode:0,committed:true,reads:9,text:'#tb 0: 1001/30000\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 5x3\n#sar 0: 0/1\n0,          0,          0,        1,       27, 0x0ccc015f\n'});
});

it('converts RGB packing and odd YUV420 planes with scoped timestamps and bounded reads inside workerd',async()=>{
 const header='#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 5x3\n#sar 0: 0/1\n';
 const expected=[['rgba','gbrp',20,45,'fa021622'],['gbrp','abgr',15,60,'759f24fd'],['nv21','yuva420p',9,42,'198a1d68'],['yuva420p','nv12',14,27,'ae350d00']] as const;
 const response=await mf.dispatchFetch('https://test/pixel-convert');expect(await response.json()).toEqual(expected.map(([source,destination,reads,bytes,checksum])=>({source,destination,exitCode:0,committed:true,reads,text:`${header}0,          1,          1,        1, ${String(bytes).padStart(8)}, 0x${checksum}\n`})));
});

it('stages converted odd NV12 video with opaque alpha through R2 inside workerd',async()=>{
 const response=await mf.dispatchFetch('https://test/pixel-convert-r2'),result=await response.json() as {exitCode:number;bytes:number[];staging:number};expect(result.exitCode).toBe(0);expect(result.staging).toBe(0);expect(Buffer.from(result.bytes).toString('hex')).toBe('0d32577ca1c6eb10355a7fa4c9ee133882cc1660aa5da7f13b85cffffffffffffffffffffffffffffffff4193e6388add2f71c41668bb0d5fa1f69b3fd4791448ed8226cb6ffffffffffffffffffffffffffffff');
});

it('converts default BT601 colors and gray ranges with native timestamps inside workerd',async()=>{
 const header='#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 5x3\n#sar 0: 0/1\n';
 const expected=[['rgba', 'yuv444p', 20, 45, 'fa721615'], ['yuv444p', 'abgr', 15, 60, '7d4623e4'], ['gbrp', 'gray', 15, 15, '3de10778'], ['gray', 'nv21', 5, 27, 'b9670d57'], ['nv12', 'gray', 9, 15, '3eba089c']] as const;
 const response=await mf.dispatchFetch('https://test/pixel-color');expect(await response.json()).toEqual(expected.map(([source,destination,reads,bytes,checksum])=>({source,destination,exitCode:0,committed:true,reads,text:`${header}0,          1,          1,        1, ${String(bytes).padStart(8)}, 0x${checksum}\n`})));
});

it('stages default RGB to YUV444 color conversion through R2 inside workerd',async()=>{
 const response=await mf.dispatchFetch('https://test/pixel-color-r2'),result=await response.json() as {exitCode:number;bytes:number[];staging:number};expect(result.exitCode).toBe(0);expect(result.staging).toBe(0);expect(Buffer.from(result.bytes).toString('hex')).toBe('35945a77bd5ab93d9c617fc562c1459696709625969696967096259696966d6dde6d7f6d6d6d6dde6d7f6d6d6da469874c69b04cac2f8e5471b754b39670967096259696969670962596966dde6dde6d7f6d6d6d6dde6d7f6d6d');
});

it('resamples chroma and converts subsampled RGB with native edge and alpha behavior inside workerd',async()=>{
 const expected=[['yuv444p', 'nv21', 5, 15, 27, 'be320d26'], ['yuv420p', 'yuv444p', 5, 9, 45, '30b8191f'], ['rgb24', 'yuv420p', 5, 15, 27, 'b8410d9b'], ['bgr24', 'yuva420p', 6, 18, 48, '7e97201a'], ['rgba', 'yuva420p', 5, 20, 42, 'b80b144b']] as const;
 const response=await mf.dispatchFetch('https://test/chroma');expect(await response.json()).toEqual(expected.map(([source,destination,width,reads,bytes,checksum])=>({source,destination,width,exitCode:0,committed:true,reads,text:`#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: ${width}x3\n#sar 0: 0/1\n0,          1,          1,        1, ${String(bytes).padStart(8)}, 0x${checksum}\n`})));
});

it('stages RGB to NV12 chroma-filtered output through R2 inside workerd',async()=>{
 const response=await mf.dispatchFetch('https://test/chroma-r2'),result=await response.json() as {exitCode:number;bytes:number[];staging:number};expect(result.exitCode).toBe(0);expect(result.staging).toBe(0);expect(Buffer.from(result.bytes).toString('hex')).toBe('35945a77bd5ab93d9c617fc562c145966d81a9517865757b71966da469874c69b04cac2f8e5471b754b3859e84a2879980ad5a77966d');
});

it('converts subsampled YUV to RGB under explicit numeric profiles with native scoped timestamps inside workerd',async()=>{
 const rejected=await mf.dispatchFetch('https://test/pixel-inverse-reject');expect(await rejected.json()).toEqual({exitCode:1,diagnostic:'unsupported-command',opens:0});
 const response=await mf.dispatchFetch('https://test/pixel-inverse');expect(await response.json()).toEqual([{"source": "yuv420p", "destination": "rgb24", "width": 16, "height": 2, "scalar": false, "exitCode": 0, "committed": true, "reads": 16, "text": "#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 16x2\n#sar 0: 0/1\n0,          1,          1,        1,       96, 0xe9312d5e\n"}, {"source": "yuv420p", "destination": "rgba", "width": 6, "height": 3, "scalar": false, "exitCode": 0, "committed": true, "reads": 10, "text": "#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 6x3\n#sar 0: 0/1\n0,          1,          1,        1,       72, 0x52932e8b\n"}, {"source": "yuva420p", "destination": "bgra", "width": 5, "height": 7, "scalar": false, "exitCode": 0, "committed": true, "reads": 32, "text": "#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 5x7\n#sar 0: 0/1\n0,          1,          1,        1,      140, 0x63a94ae7\n"}, {"source": "yuv422p", "destination": "gbrp", "width": 5, "height": 3, "scalar": false, "exitCode": 0, "committed": true, "reads": 11, "text": "#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 5x3\n#sar 0: 0/1\n0,          1,          1,        1,       45, 0x34711726\n"}, {"source": "nv21", "destination": "argb", "width": 16, "height": 6, "scalar": true, "exitCode": 0, "committed": true, "reads": 48, "text": "#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 16x6\n#sar 0: 0/1\n0,          1,          1,        1,      384, 0xfe2eebc3\n"}, {"source": "nv12", "destination": "rgb24", "width": 5, "height": 3, "scalar": false, "exitCode": 0, "committed": true, "reads": 9, "text": "#tb 0: 1/25\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 5x3\n#sar 0: 0/1\n0,          1,          1,        1,       45, 0x0967196e\n"}]);
});

it('stages interpolated YUV420 to RGBA output through isolated R2 keys inside workerd',async()=>{
 const response=await mf.dispatchFetch('https://test/pixel-inverse-r2'),result=await response.json() as {exitCode:number;bytes:number[];staging:number};expect(result.exitCode).toBe(0);expect(result.staging).toBe(0);expect(Buffer.from(result.bytes).toString('hex')).toBe('006f00ff009a00ff00980cff4b9782ff76c2adffdcc1ffffffecffff430099ffa900ffffd400ffff896ed0ffb499fbffff98ffffff96ffff8200e7ffffca46ffd20000ff009900ff069832ff31c35dff97c2d3ffc2edfeffffebffff6400bfff8f00ebff446f80ff6f9aabffd599ffffff97ffffffc2ffff');
});

for(const [arithmetic,route]of [['aarch64','video-filter-labelled-r2'],['x86_64','video-filter-labelled-linux-r2']] as const)it(`matches native ${arithmetic} labelled single-path video graphs through bounded R2 staging`,async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/filter-labelled-worker.json','utf8')) as {cases:{id:string;native:Record<'aarch64'|'x86_64',string>}[]},response=await mf.dispatchFetch(`https://test/${route}`),results=await response.json() as {id:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(8);for(const result of results){expect(result.exitCode,result.id).toBe(0);expect(result.reads,result.id).toBeGreaterThan(1);expect(result.staging,result.id).toBe(0);expect(result.text,result.id).toBe(fixture.cases.find(item=>item.id===result.id)!.native[arithmetic]);}
});

for(const [arithmetic,route]of [['aarch64','video-transpose-r2'],['x86_64','video-transpose-linux-r2']] as const)it(`matches native ${arithmetic} transpose video graphs through bounded R2 staging`,async()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/transpose-worker.json','utf8')) as {cases:{id:string;native:Record<'aarch64'|'x86_64',string>}[]},response=await mf.dispatchFetch(`https://test/${route}`),results=await response.json() as {id:string;exitCode:number;text:string;reads:number;staging:number}[];
 expect(results).toHaveLength(8);for(const result of results){expect(result.exitCode,result.id).toBe(0);expect(result.reads,result.id).toBeGreaterThan(1);expect(result.staging,result.id).toBe(0);expect(result.text,result.id).toBe(fixture.cases.find(item=>item.id===result.id)!.native[arithmetic]);}
});
