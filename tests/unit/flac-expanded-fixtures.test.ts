import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import upstream from '../../compat/upstream.lock.json' with {type:'json'};
import codec from '../../tools/codecs/flac/inputs.json' with {type:'json'};

interface Row {id:string;input:string;inputSha256:string;args:string[];output:string;outputSha256:string;exitCode:number}
interface Corpus {reference:{commit:string;version:string;platform:string;arch:string;flags:string[];compiler:string;targetPlatformMatches:boolean;reproducibleToolchainPinned:boolean;artifacts:{ffmpeg:string;ffprobe:string}};binarySha256:string;wasmSha256:string;rows:Row[]}
const load=(name:string)=>JSON.parse(readFileSync(`compat/behavior-specs/${name}/cases.json`,'utf8')) as Corpus;
const prepass=load('flac-prepass'),output=load('flac-output');
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const digest=/^[a-f0-9]{64}$/;
for(const [name,corpus,count] of [['prepass',prepass,162],['output',output,342]] as const)describe(`expanded Native FLAC ${name} fixture`,()=>{
 it('retains explicit Native provenance and the required precompiled module',()=>{
  expect(corpus.reference.commit).toBe(upstream.commit);
  expect(corpus.reference.version).toContain(`ffmpeg version ${upstream.tag}`);
  expect(corpus.reference.platform).toBe('darwin');expect(corpus.reference.arch).toBe('arm64');
  expect(corpus.reference.flags).toEqual(['--disable-autodetect','--disable-doc','--disable-debug','--disable-x86asm']);
  expect(corpus.reference.compiler).toContain('Apple clang');
  expect(corpus.reference.targetPlatformMatches).toBe(false);
  expect(corpus.reference.reproducibleToolchainPinned).toBe(false);
  expect(corpus.binarySha256).toBe('1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
  expect(corpus.reference.artifacts.ffmpeg).toBe(corpus.binarySha256);
  expect(corpus.reference.artifacts.ffprobe).toMatch(digest);
  const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');
  expect(wasm.length).toBe(codec.wasmBytes);expect(sha(wasm)).toBe(codec.wasmSha256);
  expect(corpus.wasmSha256).toBe(codec.wasmSha256);
 });
 it('validates every row, canonical encoded bytes, hashes and bounded fixture schema without optional skips',()=>{
  expect(corpus.rows).toHaveLength(count);const ids=new Set<string>();
  for(const row of corpus.rows){
   expect(Object.keys(row).sort(),row.id).toEqual(['args','exitCode','id','input','inputSha256','output','outputSha256']);
   expect(ids.has(row.id),row.id).toBe(false);ids.add(row.id);
   expect(row.id.length).toBeGreaterThan(0);expect(row.exitCode,row.id).toBe(0);
   expect(row.inputSha256).toMatch(digest);expect(row.outputSha256).toMatch(digest);
   for(const [encoded,hash] of [[row.input,row.inputSha256],[row.output,row.outputSha256]]){
    expect(typeof encoded,row.id).toBe('string');const bytes=Buffer.from(encoded!,'base64');
    expect(bytes.toString('base64'),row.id).toBe(encoded);expect(bytes.length).toBeLessThanOrEqual(1048576);expect(sha(bytes),row.id).toBe(hash);
   }
   expect(Buffer.from(row.input,'base64').subarray(0,4).toString()).toBe('fLaC');
   expect(row.args.slice(0,6)).toEqual(['-i','/in.flac','-map','0:a','-map_metadata','-1']);
   expect(row.args.at(-1)).toBe('/out');expect(row.args.length).toBeLessThanOrEqual(64);
   for(const arg of row.args){expect(typeof arg).toBe('string');expect(arg.length).toBeLessThanOrEqual(512);}
  }
 });
});
it('preserves the complete known/unknown total and positive frame-limit prepass matrix',()=>{
 const expected:string[]=[];
 for(const samples of [0,257,1000])for(const total of ['known','unknown'])for(const format of ['wav','s16le','framecrc']){
  expected.push(`${samples}/${total}/${format}/-frames:a/all`);
  for(const limit of [0,1,2,99])for(const alias of ['-frames:a','-aframes'])expected.push(`${samples}/${total}/${format}/${alias}/${limit}`);
 }
 expect(prepass.rows.map(row=>row.id).sort()).toEqual(expected.sort());
 for(const row of prepass.rows){
  const [samples,total,format,alias,limit]=row.id.split('/'),input=Buffer.from(row.input,'base64');
  expect(input.readBigUInt64BE(18)&0xfffffffffn).toBe(BigInt(total==='known'?samples!:0));
  expect(row.args.slice(-3,-1)).toEqual(['-f',format]);
  if(limit!=='all')expect(row.args.slice(6,8)).toEqual([alias,limit]);
 }
});
it('preserves every AIFF/AU codec, bitexact mode and input-depth/pattern case',()=>{
 const expected:string[]=[];
 for(const bits of [16,24,32])for(const pattern of ['empty','ramp','extremes'])for(const format of ['aiff','au']){
  const codecs=['','pcm_s8','pcm_s16be','pcm_s24be','pcm_s32be',...(format==='aiff'?['pcm_s16le']:[]),'pcm_f32be','pcm_f64be','pcm_alaw','pcm_mulaw'];
  for(const codec of codecs)for(const bitexact of [false,true])expected.push(`${bits}-2-${pattern}-5/${format}${codec?'/'+codec:''}${bitexact?'/bitexact':''}`);
 }
 expect(output.rows.map(row=>row.id).sort()).toEqual(expected.sort());
 for(const row of output.rows){
  const [,format,...options]=row.id.split('/');expect(row.args.slice(-3,-1)).toEqual(['-f',format]);
  expect(row.args.includes('-bitexact')).toBe(options.includes('bitexact'));
  const codec=options.find(option=>option.startsWith('pcm_'));if(codec)expect(row.args.slice(6,8)).toEqual(['-c:a',codec]);
 }
});
