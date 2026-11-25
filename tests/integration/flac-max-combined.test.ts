import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {flacNativeCorpus} from '../helpers/flac-native-corpus.js';
import {assertCorpusReference,pinnedReference,referencePin,verifyPlatformCorpus} from '../helpers/reference-identity.js';
import arithmeticProfile from '../../compat/behavior-specs/flac-max-remix/arithmetic.json' with {type:'json'};
const {corpus,darwin}=flacNativeCorpus('flac-max-combined'),{corpus:scalar,darwin:darwinScalar}=flacNativeCorpus('flac-max-combined','scalar.json');

const wasm=readFileSync('.build/codecs/flac/edge-flac.wasm');
const module=new WebAssembly.Module(wasm);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
it('pins the independently captured combined-feature oracle and decoder',()=>{
 expect(hash(readFileSync('.build/reference/ffmpeg'))).toBe(corpus.binarySha256);
 expect(hash(wasm)).toBe(corpus.wasmSha256);
 expect(corpus.rows).toHaveLength(40);
 expect(scalar.rows).toHaveLength(18);expect(scalar.binarySha256).toBe(corpus.binarySha256);expect(scalar.wasmSha256).toBe(corpus.wasmSha256);
 // Rows come from this host's pinned reference; the darwin-arm64 rows stay labelled evidence with the same ids.
 expect(corpus.binarySha256).toBe(pinnedReference().ffmpeg);expect(darwin.binarySha256).toBe(referencePin('darwin-arm64').artifacts.ffmpeg);expect(corpus.rows.map(row=>row.id)).toEqual(darwin.rows.map(row=>row.id));
 expect(scalar.binarySha256).toBe(pinnedReference().ffmpeg);expect(darwinScalar.binarySha256).toBe(darwin.binarySha256);expect(scalar.rows.map(row=>row.id).sort()).toEqual(darwinScalar.rows.map(row=>row.id).sort());
 if(pinnedReference().id!=='darwin-arm64')assertCorpusReference(verifyPlatformCorpus('compat/behavior-specs/flac-max-combined'));
});
const needsScalar=(row:{id:string;args:string[]})=>!row.args.includes('-cpuflags')&&(row.args.includes('-ar')||row.id.endsWith('/volume-remix')||row.id.startsWith('24-')&&row.id.endsWith('/pad-remix'));
for(const row of [...corpus.rows,...scalar.rows])it(`${row.args.slice(0,row.args.indexOf('-i')).includes('-ss')?'records explicit input-seek compatibility gap':needsScalar(row)?'records explicit CPU rounding compatibility gap':'public FLAC backend matches Native combined features'}: ${row.id}`,async()=>{
 const input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];
 expect(hash(input)).toBe(row.inputSha256);
 let opens=0,commits=0,aborts=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),
  budget:{maxResidentBytes:67108864,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:15000},
  filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,31));}};},
   async openWrite(){opens++;return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){aborts++;chunks.length=0;}};}}});
 const result=await ffmpeg.exec(row.args);
 // These eight successful Native seeks are retained as evidence of a gap.
 // They are rejection tests, never counted as byte-compatible executions.
 if(row.args.slice(0,row.args.indexOf('-i')).includes('-ss')){
  expect(row.exitCode).toBe(0);expect(result.exitCode).not.toBe(0);
  expect(result.diagnostics[0]?.code).toBe('unsupported-command');
  expect(result.diagnostics[0]?.message).toMatch(/demux seeking/);
  expect(opens).toBe(0);expect(commits).toBe(0);expect(chunks).toEqual([]);return;
 }
 if(needsScalar(row)){
  expect(row.exitCode).toBe(0);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/requires -cpuflags 0/);
  expect(opens).toBe(0);expect(commits).toBe(0);expect(chunks).toEqual([]);return;
 }
 expect(result.diagnostics).toEqual([]);
 expect(result.exitCode).toBe(row.exitCode);
 const output=Buffer.concat(chunks);
 expect(hash(output),JSON.stringify({bytes:output.length,expectedBytes:Buffer.from(row.output!,'base64').length,firstBytes:output.subarray(0,32).toString('hex'),expectedFirstBytes:Buffer.from(row.output!,'base64').subarray(0,32).toString('hex')})).toBe(row.outputSha256);
 expect(output.toString('base64')).toBe(row.output);
 expect(opens).toBe(1);expect(commits).toBe(1);expect(aborts).toBe(0);
});
for(const mode of ['framecrc','frame-limit'])it(`rejects unimplemented FLAC resampled packet scheduling before output: ${mode}`,async()=>{
 const row=scalar.rows.find(row=>row.id==='16-2-ramp-5/known/remix-resample/scalar')!,input=Buffer.from(row.input,'base64'),args=[...row.args];
 if(mode==='framecrc')args[args.indexOf('-f')+1]='framecrc';else args.splice(args.length-1,0,'-frames:a','1');
 let opens=0;
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module}}),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,31));}};},async openWrite(){opens++;throw Error('Output must not open');}}});
 const result=await ffmpeg.exec(args);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code).toBe('unsupported-command');expect(result.diagnostics[0]?.message).toMatch(/Native packet scheduling/);expect(opens).toBe(0);
});
it('propagates the explicit fused remix profile through the public FLAC backend',async()=>{
 const row=arithmeticProfile.scalarCase,input=Buffer.from(row.input,'base64'),chunks:Uint8Array[]=[];
 expect(arithmeticProfile.scalar.arithmetic).toBe('fused');
 const ffmpeg=new FFmpeg({backend:createMediaBackend({flac:{module},remixArithmetic:'fused'}),budget:{maxResidentBytes:33554432,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+Math.min(length,31));}};},async openWrite(){return {async write(bytes){chunks.push(bytes.slice());},async commit(){},async abort(){chunks.length=0;}};}}});
 const result=await ffmpeg.exec(row.args);expect(result.diagnostics).toEqual([]);expect(result.exitCode).toBe(0);expect(hash(Buffer.concat(chunks))).toBe(row.outputSha256);
});
